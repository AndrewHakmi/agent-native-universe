import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { link, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EvidenceConflictError, EvidenceStore } from "./artifacts.js";
import { canonicalJson, hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { verifyCompletedRunEvidence } from "./evidence-verifier.js";
import {
  ensureNoSymlinkDirectoryHierarchy,
  openRegularFileNoFollow,
  withAnchoredParentDirectory,
  type AnchoredDirectory,
} from "./event-stream.js";
import { runGenesis, type GenesisRunOptions } from "./genesis.js";
import {
  createRunManifest,
  LAB_ENGINE_VERSION,
  LAB_POLICY_ID,
  LAB_TASK_GENERATOR_ID,
  populationSeed,
} from "./manifest.js";
import {
  LAB_SCHEMA_VERSION,
  type GenesisConfig,
  type PopulationSummary,
  type RunSummary,
} from "./types.js";

export const MAX_POPULATION_PARALLELISM = 64;
export const MAX_POPULATION_UNIVERSES = 10_000;
export const LAB_POPULATION_PROTOCOL_ID = "deterministic-population-v1";

const MAX_POPULATION_SUMMARY_BYTES = 64 * 1024 * 1024;

export type GenesisRunExecutor = (options: GenesisRunOptions) => Promise<RunSummary>;

export interface PopulationRunOptions {
  config: GenesisConfig;
  runsRoot: string;
  universes: number;
  parallel?: number;
  /**
   * Test/integration seam; production callers use the manifest-bound Genesis
   * runner. It is not an identity input. Injected output is verified against
   * its deterministic manifest, config, stored summary, metrics and complete
   * event replay before it can enter a population catalogue.
   */
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
  const populationIdValue = createPopulationId(baseConfig, options.universes);
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
      const expectedManifest = createRunManifest(config, id);
      try {
        const summary = await execute({
          config: structuredClone(config),
          runsRoot: options.runsRoot,
          universeId: id,
        });
        assertSummaryIdentity(summary, expectedManifest.runId, id, config);
        if (options.runUniverse !== undefined) {
          await assertInjectedSummaryEvidence(
            summary,
            expectedManifest,
            config,
            options.runsRoot,
          );
        }
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
  await writePopulationSummary(options.runsRoot, populationIdValue, population);
  return structuredClone(population);
}

export function universeId(ordinal: number): string {
  assertPositiveBoundedInteger(ordinal, 99_999_999, "universe ordinal");
  return `U${String(ordinal).padStart(4, "0")}`;
}

/**
 * Address one production population by every declared scientific input that
 * may change its result.
 *
 * Worker parallelism and the storage root are deliberately absent: they are
 * operational choices and must not fork otherwise identical evidence.
 */
export function createPopulationId(config: GenesisConfig, universes: number): string {
  validateGenesisConfig(config);
  assertPositiveBoundedInteger(universes, MAX_POPULATION_UNIVERSES, "universes");
  const digest = hashValue({
    domain: "agent-native-universe/lab/population-identity/v1",
    populationProtocolId: LAB_POPULATION_PROTOCOL_ID,
    implementation: {
      engineVersion: LAB_ENGINE_VERSION,
      policyId: LAB_POLICY_ID,
      taskGeneratorId: LAB_TASK_GENERATOR_ID,
    },
    config,
    universes,
  });
  return `population-${digest}`;
}

/**
 * Return an immutable population summary path.
 *
 * Omitting `populationId` intentionally preserves the original v1 path for
 * callers that need to read legacy `<experiment>/population.json` evidence.
 * New writers always pass a deterministic population identity.
 */
export function populationSummaryPath(
  runsRoot: string,
  experimentId: string,
  populationId?: string,
): string {
  if (!runsRoot) throw new TypeError("Population runs root must not be empty");
  assertSafeIdentifier(experimentId, "population experiment id");
  const experimentDirectory = join(resolve(runsRoot), experimentId);
  if (populationId === undefined) return join(experimentDirectory, "population.json");
  assertSafeIdentifier(populationId, "population id");
  return join(experimentDirectory, "populations", populationId, "population.json");
}

let temporarySequence = 0;

async function writePopulationSummary(
  runsRoot: string,
  populationId: string,
  summary: PopulationSummary,
): Promise<void> {
  const path = populationSummaryPath(runsRoot, summary.experimentId, populationId);
  const serialized = canonicalJson(summary);
  if (Buffer.byteLength(serialized, "utf8") > MAX_POPULATION_SUMMARY_BYTES) {
    throw new Error(
      `Population summary exceeds the ${MAX_POPULATION_SUMMARY_BYTES}-byte safety limit`,
    );
  }
  await ensureNoSymlinkDirectoryHierarchy(dirname(path));

  const existing = await readIfPresent(path);
  if (existing !== undefined) {
    if (existing === serialized) return;
    throw new EvidenceConflictError("Refusing to replace existing population summary");
  }

  await withAnchoredParentDirectory(path, {}, async (directory, name) => {
    const temporaryName = `${name}.tmp-${process.pid}-${temporarySequence += 1}`;
    let handle: Awaited<ReturnType<typeof openRegularFileNoFollow>> | undefined;
    try {
      handle = await directory.openRegular(
        temporaryName,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        // Hard-link publication stays relative to one held parent descriptor.
        await link(directory.entry(temporaryName), directory.entry(name));
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const concurrent = await readFromAnchoredDirectory(directory, name);
        if (concurrent !== serialized) {
          throw new EvidenceConflictError("Concurrent population summary conflicts with this run");
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(directory.entry(temporaryName)).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  });
}

async function readIfPresent(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>;
  try {
    handle = await openRegularFileNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readPopulationHandle(handle, path);
}

async function readFromAnchoredDirectory(
  directory: AnchoredDirectory,
  name: string,
): Promise<string> {
  const handle = await directory.openRegular(name, constants.O_RDONLY);
  return readPopulationHandle(handle, `${directory.displayPath}/${name}`);
}

async function readPopulationHandle(
  handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>,
  path: string,
): Promise<string> {
  try {
    const info = await handle.stat();
    if (info.size > MAX_POPULATION_SUMMARY_BYTES) {
      throw new Error(
        `Population summary exceeds the ${MAX_POPULATION_SUMMARY_BYTES}-byte safety limit`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_POPULATION_SUMMARY_BYTES) {
      throw new Error(
        `Population summary exceeds the ${MAX_POPULATION_SUMMARY_BYTES}-byte safety limit`,
      );
    }
    if (!isUtf8(bytes)) throw new Error(`Population summary is not valid UTF-8: ${path}`);
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

function assertSummaryIdentity(
  summary: RunSummary,
  expectedRunId: string,
  universeIdValue: string,
  config: GenesisConfig,
): void {
  if (summary.schemaVersion !== LAB_SCHEMA_VERSION) {
    throw new Error(`Runner returned the wrong schema for ${universeIdValue}`);
  }
  if (summary.runId !== expectedRunId) {
    throw new Error(`Runner returned the wrong run id for ${universeIdValue}`);
  }
  if (summary.universeId !== universeIdValue) {
    throw new Error(`Runner returned ${summary.universeId} for ${universeIdValue}`);
  }
  if (summary.seed !== config.seed) {
    throw new Error(`Runner returned the wrong seed for ${universeIdValue}`);
  }
  if (summary.ticks !== config.ticks) {
    throw new Error(`Runner returned the wrong tick count for ${universeIdValue}`);
  }
}

async function assertInjectedSummaryEvidence(
  returned: RunSummary,
  expectedManifest: ReturnType<typeof createRunManifest>,
  expectedConfig: GenesisConfig,
  runsRoot: string,
): Promise<void> {
  const evidence = await EvidenceStore.openExisting(
    runsRoot,
    expectedManifest.experimentId,
    expectedManifest.universeId,
    expectedManifest.runId,
  );
  const verifiedEvidence = await verifyCompletedRunEvidence(evidence);
  const { manifest, config, summary: verified } = verifiedEvidence;
  if (hashValue(manifest) !== hashValue(expectedManifest)) {
    throw new Error(`Injected runner evidence manifest mismatch for ${expectedManifest.universeId}`);
  }
  if (hashValue(config) !== hashValue(expectedConfig)) {
    throw new Error(`Injected runner evidence config mismatch for ${expectedManifest.universeId}`);
  }

  if (hashValue(returned) !== hashValue(verified)) {
    throw new Error(`Injected runner summary does not match verified evidence for ${manifest.universeId}`);
  }
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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertSafeIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    || value.includes("..")
  ) {
    throw new TypeError(`${label} is unsafe`);
  }
}
