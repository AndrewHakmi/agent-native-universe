import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import {
  link,
  opendir,
  readdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, hashValue } from "./canonical.js";
import { LabEventRecorder } from "./event-recorder.js";
import {
  ensureNoSymlinkDirectoryHierarchy,
  openRegularFileNoFollow,
  unlinkEntryNoFollow,
  withAnchoredDirectory,
  withAnchoredParentDirectory,
  type AnchoredDirectory,
} from "./event-stream.js";
import {
  assertLabManifestImplementation,
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

const MAX_DISCOVERY_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 1_048_576;

export interface EvidenceStoreOptions {
  /** Retain the full event log for synchronous inspection. Disable for long runs. */
  retainEvents?: boolean;
  /** Address evidence by immutable run identity below the universe directory. */
  runId?: string;
}

/**
 * Durable evidence layout rooted at
 * `<runsRoot>/<experiment>/<universe>/<runId>` for new runs. Legacy evidence
 * directly below `<universe>` remains readable through `openExisting`.
 *
 * Scientific JSON is canonical and contains only caller-provided logical
 * values. The store never injects wall-clock timestamps into payloads.
 */
export class EvidenceStore {
  readonly runsRoot: string;
  readonly experimentId: string;
  readonly universeId: string;
  readonly runId: string | undefined;
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
  readonly #retainEvents: boolean;

  constructor(
    runsRoot: string,
    experimentId: string,
    universeId: string,
    options: EvidenceStoreOptions = {},
  ) {
    if (!runsRoot) throw new TypeError("Evidence runs root must not be empty");
    assertSafeIdentifier(experimentId, "experiment id");
    assertSafeIdentifier(universeId, "universe id");
    if (options.runId !== undefined) assertSafeIdentifier(options.runId, "run id");
    this.runsRoot = resolve(runsRoot);
    this.experimentId = experimentId;
    this.universeId = universeId;
    this.runId = options.runId;
    this.directory = options.runId === undefined
      ? containedPath(this.runsRoot, experimentId, universeId)
      : containedPath(this.runsRoot, experimentId, universeId, options.runId);
    this.checkpointsDirectory = containedPath(this.directory, "checkpoints");
    this.manifestPath = containedPath(this.directory, "manifest.json");
    this.configPath = containedPath(this.directory, "config.json");
    this.eventsPath = containedPath(this.directory, "events.jsonl");
    this.metricsPath = containedPath(this.directory, "metrics.jsonl");
    this.summaryPath = containedPath(this.directory, "summary.json");
    this.#retainEvents = options.retainEvents !== false;
  }

  static async initialize(
    runsRoot: string,
    manifest: RunManifest,
    config: GenesisConfig,
    options: EvidenceStoreOptions = {},
  ): Promise<EvidenceStore> {
    if (options.runId !== undefined && options.runId !== manifest.runId) {
      throw new Error("Evidence store run id does not match the manifest");
    }
    const store = new EvidenceStore(
      runsRoot,
      manifest.experimentId,
      manifest.universeId,
      { ...options, runId: manifest.runId },
    );
    await store.initialize(manifest, config);
    return store;
  }

  /**
   * Open already-published evidence without guessing between multiple runs.
   *
   * With an explicit run id, the canonical child directory is selected first
   * and a matching legacy manifest is used only as a compatibility fallback.
   * Without one, exactly one evidence candidate supported by this engine must
   * exist. Directory and artifact symlinks are never followed.
   */
  static async openExisting(
    runsRoot: string,
    experimentId: string,
    universeId: string,
    runId?: string,
  ): Promise<EvidenceStore> {
    if (runId !== undefined) assertSafeIdentifier(runId, "run id");
    const legacy = new EvidenceStore(runsRoot, experimentId, universeId);
    const hierarchyExists = await validateDiscoveryHierarchy(legacy);
    if (!hierarchyExists) {
      throw selectionError(experimentId, universeId, runId);
    }

    if (runId !== undefined) {
      const addressed = new EvidenceStore(runsRoot, experimentId, universeId, { runId });
      const exact = await inspectEvidenceCandidate(addressed, runId);
      if (exact.kind === "supported") return addressed;
      if (exact.kind === "unsupported") throw unsupportedImplementationError(exact);

      const legacyCandidate = await inspectEvidenceCandidate(legacy);
      if (legacyCandidate.kind !== "missing" && legacyCandidate.manifest.runId === runId) {
        if (legacyCandidate.kind === "unsupported") {
          throw unsupportedImplementationError(legacyCandidate);
        }
        return legacy;
      }
      throw selectionError(experimentId, universeId, runId);
    }

    const candidates: EvidenceStore[] = [];
    const legacyCandidate = await inspectEvidenceCandidate(legacy);
    if (legacyCandidate.kind === "supported") candidates.push(legacy);

    const entryNames: string[] = [];
    let entryCount = 0;
    await withAnchoredDirectory(legacy.directory, {}, async (anchored) => {
      const directory = await opendir(anchored.path);
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAX_DISCOVERY_ENTRIES) {
          throw new Error(
            `Evidence universe exceeds the ${MAX_DISCOVERY_ENTRIES}-entry discovery limit`,
          );
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`Refusing symbolic link evidence entry ${entry.name}`);
        }
        if (!entry.isDirectory() || !isSafeIdentifier(entry.name)) continue;
        entryNames.push(entry.name);
      }
    });
    entryNames.sort(compareCodeUnits);
    for (const entryName of entryNames) {
      const addressed = new EvidenceStore(runsRoot, experimentId, universeId, {
        runId: entryName,
      });
      const candidate = await inspectEvidenceCandidate(addressed, entryName);
      if (candidate.kind === "supported") candidates.push(addressed);
    }

    if (candidates.length !== 1) {
      const available = candidates
        .map((candidate) => candidate.runId ?? (legacyCandidate.kind === "missing"
          ? "legacy"
          : legacyCandidate.manifest.runId))
        .join(", ");
      const detail = available ? ` (${available})` : "";
      if (candidates.length === 0) {
        throw new EvidenceConflictError(
          `No supported evidence runs found for ${experimentId}/${universeId}`,
        );
      }
      throw new EvidenceConflictError(
        `Multiple supported evidence runs found for ${experimentId}/${universeId}${detail}; specify --run-id`,
      );
    }
    return candidates[0]!;
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
    await ensureNoSymlinkDirectoryHierarchy(this.directory);
    const path = containedPath(this.directory, ".runner.lock");
    let handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>;
    try {
      handle = await openRegularFileNoFollow(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
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
      await unlinkEntryNoFollow(path).catch(() => undefined);
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
      await unlinkEntryNoFollow(path);
    };
  }

  async initialize(manifest: RunManifest, config: GenesisConfig): Promise<LabEventRecorder> {
    validateManifest(manifest);
    if (manifest.experimentId !== this.experimentId || manifest.universeId !== this.universeId) {
      throw new Error("Manifest does not match the evidence directory");
    }
    if (this.runId !== undefined && manifest.runId !== this.runId) {
      throw new Error("Manifest run id does not match the evidence directory");
    }
    if (config.experimentId !== manifest.experimentId) {
      throw new Error("Config experiment does not match the manifest");
    }
    const computedConfigHash = hashValue(config);
    if (computedConfigHash !== manifest.configHash) {
      throw new Error(`Config hash mismatch: expected ${manifest.configHash}, got ${computedConfigHash}`);
    }

    await ensureNoSymlinkDirectoryHierarchy(this.checkpointsDirectory);
    await this.#writeImmutable(this.manifestPath, manifest, "manifest");
    await this.#writeImmutable(this.configPath, config, "config");
    await ensureAppendFile(this.metricsPath);
    this.#lastMetricTick = lastMetricTick(await readCanonicalJsonl<MetricsSnapshot>(this.metricsPath));
    this.#recorder = await LabEventRecorder.open(this.eventsPath, manifest, {
      retainEvents: this.#retainEvents,
    });
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
    if (this.runId !== undefined && manifest.runId !== this.runId) {
      throw new Error("Stored manifest run id does not match its evidence directory");
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
      entries = await withAnchoredDirectory(
        this.checkpointsDirectory,
        {},
        (directory) => readdir(directory.path),
      );
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
      const existing = await readTextNoFollow(path);
      if (existing === serialized) return;
      throw new EvidenceConflictError(`Refusing to replace existing ${label}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicCanonicalWrite(path, serialized);
  }
}

type CandidateInspection =
  | { kind: "missing" }
  | { kind: "supported"; manifest: RunManifest }
  | { kind: "unsupported"; manifest: RunManifest; reason: string };

async function validateDiscoveryHierarchy(store: EvidenceStore): Promise<boolean> {
  const experimentDirectory = containedPath(store.runsRoot, store.experimentId);
  for (const [path, label] of [
    [store.runsRoot, "runs root"],
    [experimentDirectory, "experiment directory"],
    [containedPath(experimentDirectory, store.universeId), "universe directory"],
  ] as const) {
    try {
      await withAnchoredDirectory(path, {}, async () => undefined);
    } catch (error) {
      if (isMissing(error)) return false;
      if (error instanceof Error && /symbolic link|non-directory/.test(error.message)) {
        throw new Error(`Refusing symbolic link or invalid ${label}`, { cause: error });
      }
      throw error;
    }
  }
  return true;
}

async function inspectEvidenceCandidate(
  store: EvidenceStore,
  expectedRunId?: string,
): Promise<CandidateInspection> {
  try {
    await withAnchoredDirectory(store.directory, {}, async (anchored) => {
      let entryCount = 0;
      const directory = await opendir(anchored.path);
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAX_DISCOVERY_ENTRIES) {
          throw new Error(
            `Evidence run exceeds the ${MAX_DISCOVERY_ENTRIES}-entry discovery limit: ${store.directory}`,
          );
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`Refusing symbolic link evidence artifact ${entry.name}`);
        }
      }
    });
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }

  let value: unknown;
  try {
    value = await readCanonicalJson<unknown>(store.manifestPath, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    if (error instanceof Error && error.message.includes(`${MAX_MANIFEST_BYTES}-byte read limit`)) {
      throw new Error(
        `Evidence manifest exceeds the ${MAX_MANIFEST_BYTES}-byte discovery limit: ${store.manifestPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Evidence manifest must be a JSON object: ${store.manifestPath}`);
  }
  const manifest = value as RunManifest;
  assertSafeIdentifier(manifest.experimentId, "manifest experiment id");
  assertSafeIdentifier(manifest.runId, "manifest run id");
  assertSafeIdentifier(manifest.universeId, "manifest universe id");
  if (manifest.experimentId !== store.experimentId || manifest.universeId !== store.universeId) {
    throw new Error("Stored manifest does not match its evidence directory");
  }
  if (expectedRunId !== undefined && manifest.runId !== expectedRunId) {
    throw new Error(
      `Evidence directory ${expectedRunId} contains manifest for ${manifest.runId}`,
    );
  }
  try {
    assertLabManifestImplementation(manifest);
  } catch (error) {
    return {
      kind: "unsupported",
      manifest,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  validateManifest(manifest);
  return { kind: "supported", manifest };
}

function unsupportedImplementationError(
  candidate: Extract<CandidateInspection, { kind: "unsupported" }>,
): Error {
  return new Error(
    `Evidence run ${candidate.manifest.runId} has an unsupported implementation: ${candidate.reason}`,
  );
}

function selectionError(
  experimentId: string,
  universeId: string,
  runId: string | undefined,
): Error {
  if (runId !== undefined) {
    return new Error(`Evidence run ${runId} was not found for ${experimentId}/${universeId}`);
  }
  return new EvidenceConflictError(
    `No supported evidence run found for ${experimentId}/${universeId}`,
  );
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !value.includes("..");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

let temporarySequence = 0;

async function atomicCanonicalWrite(path: string, serialized: string): Promise<void> {
  await withAnchoredParentDirectory(path, { create: true }, async (directory, name) => {
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
        // Both names stay anchored to the same held directory descriptor.
        await link(directory.entry(temporaryName), directory.entry(name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const concurrent = await readTextFromAnchoredDirectory(directory, name);
        if (concurrent !== serialized) {
          throw new EvidenceConflictError("Concurrent immutable artifact conflicts with this run");
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

async function appendCanonicalLine(path: string, value: unknown): Promise<void> {
  await ensureNoSymlinkDirectoryHierarchy(dirname(path));
  const handle = await openRegularFileNoFollow(
    path,
    constants.O_WRONLY | constants.O_APPEND,
  );
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureAppendFile(path: string): Promise<void> {
  await ensureNoSymlinkDirectoryHierarchy(dirname(path));
  const handle = await openRegularFileNoFollow(
    path,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
  );
  await handle.close();
}

async function readCanonicalJson<T>(path: string, maxBytes?: number): Promise<T> {
  const text = await readTextNoFollow(path, maxBytes);
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
    text = await readTextNoFollow(path);
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

async function readTextNoFollow(path: string, maxBytes?: number): Promise<string> {
  const handle = await openRegularFileNoFollow(path, constants.O_RDONLY);
  return readTextFromHandle(handle, path, maxBytes);
}

async function readTextFromAnchoredDirectory(
  directory: AnchoredDirectory,
  name: string,
  maxBytes?: number,
): Promise<string> {
  const handle = await directory.openRegular(name, constants.O_RDONLY);
  return readTextFromHandle(handle, `${directory.displayPath}/${name}`, maxBytes);
}

async function readTextFromHandle(
  handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>,
  path: string,
  maxBytes?: number,
): Promise<string> {
  try {
    const bytes = maxBytes === undefined
      ? await handle.readFile()
      : await readBytesBounded(handle, maxBytes, path);
    if (!isUtf8(bytes)) throw new Error(`Artifact is not valid UTF-8: ${path}`);
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readBytesBounded(
  handle: Awaited<ReturnType<typeof openRegularFileNoFollow>>,
  maxBytes: number,
  path: string,
): Promise<Buffer> {
  const info = await handle.stat();
  if (info.size > maxBytes) {
    throw new Error(`Artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
  }
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const remaining = maxBytes - position;
    const buffer = Buffer.allocUnsafe(Math.min(65_536, remaining + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maxBytes) {
      throw new Error(`Artifact exceeds the ${maxBytes}-byte read limit: ${path}`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

function validateManifest(manifest: RunManifest): void {
  assertSafeIdentifier(manifest.experimentId, "manifest experiment id");
  assertSafeIdentifier(manifest.runId, "manifest run id");
  assertSafeIdentifier(manifest.universeId, "manifest universe id");
  if (typeof manifest.seed !== "string" || manifest.seed.length === 0) {
    throw new Error("Manifest seed must be a non-empty string");
  }
  assertLabManifestImplementation(manifest);
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
    || !isSafeIdentifier(value)
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
