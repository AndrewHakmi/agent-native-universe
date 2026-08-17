import { EvidenceConflictError, EvidenceStore } from "./artifacts.js";
import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { createRunManifest } from "./manifest.js";
import { ReplayEngine, type ReplayResult } from "./replay.js";
import {
  LAB_SCHEMA_VERSION,
  type GenesisConfig,
  type MetricsSnapshot,
  type RunManifest,
  type RunSummary,
  type WorldState,
} from "./types.js";
import { LogicalUniverse } from "./world.js";

export interface GenesisRunOptions {
  config: GenesisConfig;
  runsRoot: string;
  universeId: string;
}

/**
 * Execute one logical Genesis universe and commit its scientific evidence.
 *
 * The live state is never accepted on trust: after completion the append-only
 * event stream is reduced from genesis again and both state hashes must match.
 */
export async function runGenesis(options: GenesisRunOptions): Promise<RunSummary> {
  if (!options.runsRoot) throw new TypeError("Genesis runs root must not be empty");
  const config = structuredClone(options.config);
  validateGenesisConfig(config);
  const manifest = createRunManifest(config, options.universeId);
  const evidence = new EvidenceStore(options.runsRoot, manifest.experimentId, manifest.universeId);
  const releaseLease = await evidence.acquireWriterLease(manifest.runId);

  try {
    await evidence.initialize(manifest, config);
    const existing = await recoverCompletedRun(evidence, manifest, config);
    if (existing) return existing;
    if (evidence.events.lastSeq !== 0) {
      throw new EvidenceConflictError(
        `Refusing to append a fresh run to incomplete evidence for ${manifest.universeId}`,
      );
    }

    const universe = new LogicalUniverse(manifest, config, evidence.events, {
      onMetrics: (metrics) => evidence.appendMetrics(metrics),
      onCheckpoint: (checkpoint) => evidence.writeCheckpoint(checkpoint),
    });
    await universe.initialize();
    await universe.run();
    await evidence.flush();

    const liveState = universe.state();
    const replay = ReplayEngine.replay(evidence.events.events(), manifest);
    assertReplayEquivalent(liveState, replay, config);
    const summary = await createSummary(evidence, manifest, config, replay);
    await evidence.writeSummary(summary);
    await evidence.flush();
    return structuredClone(summary);
  } catch (error) {
    // Do not remove partial artifacts: a failed run is itself diagnostic evidence.
    await evidence.flush().catch(() => undefined);
    throw error;
  } finally {
    await releaseLease();
  }
}

async function recoverCompletedRun(
  evidence: EvidenceStore,
  manifest: RunManifest,
  config: GenesisConfig,
): Promise<RunSummary | undefined> {
  const stored = await evidence.readSummary();
  if (evidence.events.lastSeq === 0) {
    if (stored) throw new EvidenceConflictError("A summary exists without an event stream");
    return undefined;
  }

  const replay = ReplayEngine.replay(evidence.events.events(), manifest);
  if (!replay.state.completed) {
    if (stored) throw new EvidenceConflictError("A summary exists for an incomplete event stream");
    return undefined;
  }
  assertCompletedReplay(replay, config);
  const reconstructed = await createSummary(evidence, manifest, config, replay);
  if (stored && hashValue(stored) !== hashValue(reconstructed)) {
    throw new EvidenceConflictError("Stored summary does not match replayed evidence");
  }
  if (!stored) await evidence.writeSummary(reconstructed);
  await evidence.flush();
  return structuredClone(stored ?? reconstructed);
}

async function createSummary(
  evidence: EvidenceStore,
  manifest: RunManifest,
  config: GenesisConfig,
  replay: ReplayResult,
): Promise<RunSummary> {
  assertCompletedReplay(replay, config);
  const metrics = await evidence.readMetrics();
  const latestMetrics = metrics.at(-1);
  if (!latestMetrics) throw new Error(`Run ${manifest.runId} completed without metrics`);
  assertMetricsMatchReplay(metrics, replay.state.metrics);

  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    seed: manifest.seed,
    ticks: config.ticks,
    events: replay.eventsApplied,
    finalStateHash: replay.stateHash,
    finalEventHash: replay.finalEventHash,
    latestMetrics: structuredClone(latestMetrics),
  };
}

function assertReplayEquivalent(
  liveState: WorldState,
  replay: ReplayResult,
  config: GenesisConfig,
): void {
  assertCompletedReplay(replay, config);
  const liveHash = hashValue(liveState);
  if (liveHash !== replay.stateHash) {
    throw new Error(
      `Replay state hash mismatch for ${liveState.universeId}: live ${liveHash}, replay ${replay.stateHash}`,
    );
  }
}

function assertCompletedReplay(replay: ReplayResult, config: GenesisConfig): void {
  if (!replay.state.completed) throw new Error("Genesis event stream has no run.completed event");
  if (replay.lastTick !== config.ticks || replay.state.tick !== config.ticks) {
    throw new Error(`Genesis ended at tick ${replay.lastTick}, expected ${config.ticks}`);
  }
  if (replay.eventsApplied === 0) throw new Error("Genesis completed without events");
}

function assertMetricsMatchReplay(
  persisted: readonly MetricsSnapshot[],
  replayed: readonly MetricsSnapshot[],
): void {
  if (hashValue(persisted) !== hashValue(replayed)) {
    throw new Error("Persisted metrics do not match metrics recorded in the event stream");
  }
}
