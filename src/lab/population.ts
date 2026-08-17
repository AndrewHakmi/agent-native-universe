import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EvidenceConflictError } from "./artifacts.js";
import { canonicalJson } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { runGenesis, type GenesisRunOptions } from "./genesis.js";
import { populationSeed } from "./manifest.js";
import {
  LAB_SCHEMA_VERSION,
  type GenesisConfig,
  type PopulationSummary,
  type RunSummary,
} from "./types.js";

export const MAX_POPULATION_PARALLELISM = 64;
export const MAX_POPULATION_UNIVERSES = 10_000;

export type GenesisRunExecutor = (options: GenesisRunOptions) => Promise<RunSummary>;

export interface PopulationRunOptions {
  config: GenesisConfig;
  runsRoot: string;
  universes: number;
  parallel?: number;
  /** Test/integration seam; production callers use the default Genesis runner. */
  runUniverse?: GenesisRunExecutor;
}

export interface PopulationFailure {
  universeId: string;
  cause: unknown;
}

export class PopulationRunError extends Error {
  readonly failures: readonly PopulationFailure[];

  constructor(failures: readonly PopulationFailure[]) {
    const ordered = [...failures].sort((left, right) => compareIds(left.universeId, right.universeId));
    super(`Population failed for ${ordered.map((failure) => failure.universeId).join(", ")}`);
    this.name = "PopulationRunError";
    this.failures = ordered;
  }
}

/**
 * Run independent deterministic universes through a bounded worker pool.
 *
 * Scheduling order is intentionally excluded from all scientific inputs: each
 * universe gets an ID-derived seed, its own evidence directory and a fixed
 * result slot. Consequently changing `parallel` cannot change universe hashes.
 */
export async function runPopulation(options: PopulationRunOptions): Promise<PopulationSummary> {
  validateGenesisConfig(options.config);
  assertPositiveBoundedInteger(options.universes, MAX_POPULATION_UNIVERSES, "universes");
  if (!options.runsRoot) throw new TypeError("Population runs root must not be empty");

  const requestedParallel = options.parallel ?? 1;
  assertPositiveBoundedInteger(requestedParallel, MAX_POPULATION_PARALLELISM, "parallel");
  const workerCount = Math.min(requestedParallel, options.universes);
  const baseConfig = structuredClone(options.config);
  const baseSeed = baseConfig.seed;
  const universeIds = Array.from(
    { length: options.universes },
    (_, index) => universeId(index + 1),
  );
  const summaries: Array<RunSummary | undefined> = new Array(options.universes);
  const failures: PopulationFailure[] = [];
  const execute = options.runUniverse ?? runGenesis;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= universeIds.length) return;
      const id = universeIds[index]!;
      const config = structuredClone(baseConfig);
      config.seed = populationSeed(baseSeed, id);
      try {
        const summary = await execute({
          config,
          runsRoot: options.runsRoot,
          universeId: id,
        });
        assertSummaryIdentity(summary, id, config.seed);
        summaries[index] = structuredClone(summary);
      } catch (cause) {
        // Evidence is append-only and intentionally left in place for diagnosis.
        failures.push({ universeId: id, cause });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failures.length > 0) throw new PopulationRunError(failures);

  const complete = summaries.map((summary, index) => {
    if (!summary) throw new Error(`Universe ${universeIds[index]} completed without a summary`);
    return summary;
  }).sort((left, right) => compareIds(left.universeId, right.universeId));

  const population: PopulationSummary = {
    schemaVersion: LAB_SCHEMA_VERSION,
    experimentId: baseConfig.experimentId,
    baseSeed,
    universes: complete,
  };
  await writePopulationSummary(options.runsRoot, population);
  return structuredClone(population);
}

export function universeId(ordinal: number): string {
  assertPositiveBoundedInteger(ordinal, 99_999_999, "universe ordinal");
  return `U${String(ordinal).padStart(4, "0")}`;
}

export function populationSummaryPath(runsRoot: string, experimentId: string): string {
  if (!runsRoot) throw new TypeError("Population runs root must not be empty");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(experimentId)) {
    throw new Error("Unsafe population experiment id");
  }
  return join(resolve(runsRoot), experimentId, "population.json");
}

let temporarySequence = 0;

async function writePopulationSummary(runsRoot: string, summary: PopulationSummary): Promise<void> {
  const path = populationSummaryPath(runsRoot, summary.experimentId);
  const serialized = canonicalJson(summary);
  await mkdir(dirname(path), { recursive: true });

  const existing = await readIfPresent(path);
  if (existing !== undefined) {
    if (existing === serialized) return;
    throw new EvidenceConflictError("Refusing to replace existing population summary");
  }

  const temporary = `${path}.tmp-${process.pid}-${temporarySequence += 1}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // Hard-link publication is atomic and cannot overwrite concurrent evidence.
      await link(temporary, path);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const concurrent = await readFile(path, "utf8");
      if (concurrent !== serialized) {
        throw new EvidenceConflictError("Concurrent population summary conflicts with this run");
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertSummaryIdentity(summary: RunSummary, universeIdValue: string, seed: string): void {
  if (summary.universeId !== universeIdValue) {
    throw new Error(`Runner returned ${summary.universeId} for ${universeIdValue}`);
  }
  if (summary.seed !== seed) throw new Error(`Runner returned the wrong seed for ${universeIdValue}`);
}

function assertPositiveBoundedInteger(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
