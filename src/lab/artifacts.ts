import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, hashValue } from "./canonical.js";
import { LabEventRecorder } from "./event-recorder.js";
import {
  LAB_ENGINE_VERSION,
  LAB_POLICY_ID,
  LAB_TASK_GENERATOR_ID,
} from "./manifest.js";
import type {
  Checkpoint,
  GenesisConfig,
  MetricsSnapshot,
  RunManifest,
  RunSummary,
} from "./types.js";

export class EvidenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceConflictError";
  }
}

/**
 * Durable evidence layout rooted at `<runsRoot>/<experiment>/<universe>`.
 *
 * Scientific JSON is canonical and contains only caller-provided logical
 * values. The store never injects wall-clock timestamps into payloads.
 */
export class EvidenceStore {
  readonly runsRoot: string;
  readonly experimentId: string;
  readonly universeId: string;
  readonly directory: string;
  readonly checkpointsDirectory: string;
  readonly manifestPath: string;
  readonly configPath: string;
  readonly eventsPath: string;
  readonly metricsPath: string;
  readonly summaryPath: string;

  #recorder: LabEventRecorder | undefined;
  #jsonTail: Promise<void> = Promise.resolve();
  #metricsTail: Promise<void> = Promise.resolve();
  #lastMetricTick = -1;

  constructor(runsRoot: string, experimentId: string, universeId: string) {
    if (!runsRoot) throw new TypeError("Evidence runs root must not be empty");
    assertSafeIdentifier(experimentId, "experiment id");
    assertSafeIdentifier(universeId, "universe id");
    this.runsRoot = resolve(runsRoot);
    this.experimentId = experimentId;
    this.universeId = universeId;
    this.directory = containedPath(this.runsRoot, experimentId, universeId);
    this.checkpointsDirectory = containedPath(this.directory, "checkpoints");
    this.manifestPath = containedPath(this.directory, "manifest.json");
    this.configPath = containedPath(this.directory, "config.json");
    this.eventsPath = containedPath(this.directory, "events.jsonl");
    this.metricsPath = containedPath(this.directory, "metrics.jsonl");
    this.summaryPath = containedPath(this.directory, "summary.json");
  }

  static async initialize(
    runsRoot: string,
    manifest: RunManifest,
    config: GenesisConfig,
  ): Promise<EvidenceStore> {
    const store = new EvidenceStore(runsRoot, manifest.experimentId, manifest.universeId);
    await store.initialize(manifest, config);
    return store;
  }

  get events(): LabEventRecorder {
    if (!this.#recorder) throw new Error("EvidenceStore has not been initialized");
    return this.#recorder;
  }

  /**
   * Acquire a cross-process exclusive writer lease for this universe.
   *
   * The lock is operational metadata, not scientific evidence. A process
   * crash intentionally leaves it behind so an operator must inspect the
   * incomplete append-only log before explicitly removing a stale lock.
   */
  async acquireWriterLease(runId: string): Promise<() => Promise<void>> {
    assertSafeIdentifier(runId, "lease run id");
    await mkdir(this.directory, { recursive: true });
    const path = containedPath(this.directory, ".runner.lock");
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new EvidenceConflictError(
          `Universe ${this.universeId} already has an active or stale writer lease`,
        );
      }
      throw error;
    }
    try {
      await handle.writeFile(canonicalJson({ pid: process.pid, runId }), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(path);
    };
  }

  async initialize(manifest: RunManifest, config: GenesisConfig): Promise<LabEventRecorder> {
    validateManifest(manifest);
    if (manifest.experimentId !== this.experimentId || manifest.universeId !== this.universeId) {
      throw new Error("Manifest does not match the evidence directory");
    }
    if (config.experimentId !== manifest.experimentId) {
      throw new Error("Config experiment does not match the manifest");
    }
    const computedConfigHash = hashValue(config);
    if (computedConfigHash !== manifest.configHash) {
      throw new Error(`Config hash mismatch: expected ${manifest.configHash}, got ${computedConfigHash}`);
    }

    await mkdir(this.checkpointsDirectory, { recursive: true });
    await this.#writeImmutable(this.manifestPath, manifest, "manifest");
    await this.#writeImmutable(this.configPath, config, "config");
    await ensureAppendFile(this.metricsPath);
    this.#lastMetricTick = lastMetricTick(await readCanonicalJsonl<MetricsSnapshot>(this.metricsPath));
    this.#recorder = await LabEventRecorder.open(this.eventsPath, manifest);
    return this.#recorder;
  }

  async writeSummary(summary: RunSummary): Promise<void> {
    this.#assertInitialized();
    if (summary.runId !== this.events.manifest.runId || summary.universeId !== this.universeId) {
      throw new Error("Summary does not match this evidence run");
    }
    await this.#enqueueJson(() => this.#writeImmutable(this.summaryPath, summary, "summary"));
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.#assertInitialized();
    validateCheckpoint(checkpoint, this.events.manifest);
    const path = this.checkpointPath(checkpoint.tick);
    await this.#enqueueJson(() => this.#writeImmutable(path, checkpoint, `checkpoint ${checkpoint.tick}`));
  }

  appendMetrics(metrics: MetricsSnapshot): Promise<void> {
    this.#assertInitialized();
    validateMetric(metrics);
    const captured = structuredClone(metrics);
    const operation = this.#metricsTail.then(async () => {
      if (captured.tick <= this.#lastMetricTick) {
        throw new EvidenceConflictError(
          `Metric tick ${captured.tick} does not advance ${this.#lastMetricTick}`,
        );
      }
      await appendCanonicalLine(this.metricsPath, captured);
      this.#lastMetricTick = captured.tick;
    });
    this.#metricsTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async readManifest(): Promise<RunManifest> {
    const manifest = await readCanonicalJson<RunManifest>(this.manifestPath);
    validateManifest(manifest);
    if (manifest.experimentId !== this.experimentId || manifest.universeId !== this.universeId) {
      throw new Error("Stored manifest does not match its evidence directory");
    }
    return manifest;
  }

  async readConfig(): Promise<GenesisConfig> {
    const config = await readCanonicalJson<GenesisConfig>(this.configPath);
    const manifest = await this.readManifest();
    if (config.experimentId !== this.experimentId || hashValue(config) !== manifest.configHash) {
      throw new Error("Stored config does not match its manifest");
    }
    return config;
  }

  async readSummary(): Promise<RunSummary | undefined> {
    const summary = await readOptionalCanonicalJson<RunSummary>(this.summaryPath);
    if (!summary) return undefined;
    const manifest = await this.readManifest();
    if (summary.runId !== manifest.runId || summary.universeId !== this.universeId) {
      throw new Error("Stored summary does not match its manifest");
    }
    return summary;
  }

  async readCheckpoint(tick: number): Promise<Checkpoint | undefined> {
    const checkpoint = await readOptionalCanonicalJson<Checkpoint>(this.checkpointPath(tick));
    if (!checkpoint) return undefined;
    validateCheckpoint(checkpoint, await this.readManifest());
    return checkpoint;
  }

  async readCheckpoints(): Promise<Checkpoint[]> {
    let entries: string[];
    try {
      entries = await readdir(this.checkpointsDirectory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const ticks = entries.map((entry) => {
      const match = /^(0|[1-9][0-9]*)\.json$/.exec(entry);
      if (!match) throw new Error(`Unexpected checkpoint artifact ${entry}`);
      const tick = Number(match[1]);
      nonNegativeSafeInteger(tick, "checkpoint filename tick");
      return tick;
    }).sort((left, right) => left - right);
    const checkpoints: Checkpoint[] = [];
    for (const tick of ticks) {
      const checkpoint = await this.readCheckpoint(tick);
      if (!checkpoint) throw new Error(`Checkpoint ${tick} disappeared during read`);
      checkpoints.push(checkpoint);
    }
    return checkpoints;
  }

  async readMetrics(): Promise<MetricsSnapshot[]> {
    const metrics = await readCanonicalJsonl<MetricsSnapshot>(this.metricsPath);
    let prior = -1;
    for (const value of metrics) {
      validateMetric(value);
      if (value.tick <= prior) throw new Error(`Metrics are not strictly ordered at tick ${value.tick}`);
      prior = value.tick;
    }
    return metrics;
  }

  checkpointPath(tick: number): string {
    nonNegativeSafeInteger(tick, "checkpoint tick");
    return containedPath(this.checkpointsDirectory, `${tick}.json`);
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.#jsonTail,
      this.#metricsTail,
      this.#recorder?.flush() ?? Promise.resolve(),
    ]);
  }

  #assertInitialized(): void {
    if (!this.#recorder) throw new Error("EvidenceStore has not been initialized");
  }

  #enqueueJson(operation: () => Promise<void>): Promise<void> {
    const queued = this.#jsonTail.then(operation);
    this.#jsonTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async #writeImmutable(path: string, value: unknown, label: string): Promise<void> {
    const serialized = canonicalJson(value);
    try {
      const existing = await readFile(path, "utf8");
      if (existing === serialized) return;
      throw new EvidenceConflictError(`Refusing to replace existing ${label}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicCanonicalWrite(path, serialized);
  }
}

let temporarySequence = 0;

async function atomicCanonicalWrite(path: string, serialized: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${temporarySequence += 1}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // Atomic publication that can never replace already published evidence.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await readFile(path, "utf8");
      if (concurrent !== serialized) {
        throw new EvidenceConflictError("Concurrent immutable artifact conflicts with this run");
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await unlink(temporary);
}

async function appendCanonicalLine(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureAppendFile(path: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  await handle.close();
}

async function readCanonicalJson<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON artifact ${path}`, { cause: error });
  }
  if (canonicalJson(value) !== text) throw new Error(`Artifact is not canonical JSON: ${path}`);
  return value as T;
}

async function readOptionalCanonicalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readCanonicalJson<T>(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readCanonicalJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new Error(`Truncated JSONL artifact ${path}`);
  const values: T[] = [];
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    if (!line) throw new Error(`Blank JSONL record at ${path}:${index + 1}`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL record at ${path}:${index + 1}`, { cause: error });
    }
    if (canonicalJson(value) !== line) throw new Error(`Non-canonical JSONL record at ${path}:${index + 1}`);
    values.push(value as T);
  }
  return values;
}

function validateManifest(manifest: RunManifest): void {
  assertSafeIdentifier(manifest.experimentId, "manifest experiment id");
  assertSafeIdentifier(manifest.runId, "manifest run id");
  assertSafeIdentifier(manifest.universeId, "manifest universe id");
  if (!manifest.seed) throw new Error("Manifest seed must not be empty");
  if (manifest.engineVersion !== LAB_ENGINE_VERSION) throw new Error("Unsupported manifest engineVersion");
  if (manifest.mode !== "logical") throw new Error("Unsupported manifest execution mode");
  if (manifest.policyId !== LAB_POLICY_ID) throw new Error("Unsupported manifest policyId");
  if (manifest.taskGeneratorId !== LAB_TASK_GENERATOR_ID) {
    throw new Error("Unsupported manifest taskGeneratorId");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.configHash)) throw new Error("Manifest configHash must be lowercase SHA-256");
}

function validateCheckpoint(checkpoint: Checkpoint, manifest: RunManifest): void {
  nonNegativeSafeInteger(checkpoint.tick, "checkpoint tick");
  nonNegativeSafeInteger(checkpoint.seq, "checkpoint sequence");
  if (checkpoint.runId !== manifest.runId || checkpoint.universeId !== manifest.universeId) {
    throw new Error("Checkpoint does not match its manifest");
  }
  if (checkpoint.state.tick !== checkpoint.tick) throw new Error("Checkpoint state tick mismatch");
  if (hashValue(checkpoint.state) !== checkpoint.stateHash) throw new Error("Checkpoint state hash mismatch");
}

function validateMetric(metric: MetricsSnapshot): void {
  nonNegativeSafeInteger(metric.tick, "metric tick");
}

function lastMetricTick(metrics: readonly MetricsSnapshot[]): number {
  let prior = -1;
  for (const metric of metrics) {
    validateMetric(metric);
    if (metric.tick <= prior) throw new Error(`Metrics are not strictly ordered at tick ${metric.tick}`);
    prior = metric.tick;
  }
  return prior;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    || value.includes("..")
  ) {
    throw new TypeError(`${label} is unsafe`);
  }
}

function containedPath(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  const relation = relative(root, path);
  if (relation === "" && parts.length > 0) throw new TypeError("Evidence path resolves to its root");
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new TypeError("Evidence path escapes its root");
  }
  return path;
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
