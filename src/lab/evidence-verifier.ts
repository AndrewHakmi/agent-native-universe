import type { EvidenceStore } from "./artifacts.js";
import { hashValue } from "./canonical.js";
import { withEvidenceVerificationSnapshotInternal } from "./evidence-verification-snapshot.js";
import type { ReplayResult } from "./replay.js";
import {
  LAB_SCHEMA_VERSION,
  type GenesisConfig,
  type MetricsSnapshot,
  type RunManifest,
  type RunSummary,
} from "./types.js";

export interface VerifiedRunEvidence {
  manifest: RunManifest;
  config: GenesisConfig;
  replay: ReplayResult;
  metrics: MetricsSnapshot[];
  summary: RunSummary;
}

/**
 * Reconstruct and validate every final artifact that an external commitment
 * is allowed to trust. This is intentionally stricter than reading summary.json.
 */
export async function verifyCompletedRunEvidence(
  evidence: EvidenceStore,
): Promise<VerifiedRunEvidence> {
  return withEvidenceVerificationSnapshotInternal(evidence, async (snapshot) => {
    const manifest = await snapshot.readManifest();
    const config = await snapshot.readConfig(manifest);
    const replay = await snapshot.replay(manifest, config);
    if (!replay.state.completed || replay.lastTick !== config.ticks || replay.state.tick !== config.ticks) {
      throw new Error(`Evidence run ${manifest.runId} is incomplete`);
    }
    if (replay.eventsApplied === 0 || replay.lastSeq !== replay.eventsApplied) {
      throw new Error(`Evidence run ${manifest.runId} has an invalid terminal sequence`);
    }

    const metrics = await snapshot.readMetrics();
    const latestMetrics = metrics.at(-1);
    if (latestMetrics === undefined || hashValue(metrics) !== hashValue(replay.state.metrics)) {
      throw new Error(`Persisted metrics do not match evidence for ${manifest.universeId}`);
    }

    const verifiedSummary: RunSummary = {
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
    const storedSummary = await snapshot.readSummary(manifest);
    if (hashValue(storedSummary) !== hashValue(verifiedSummary)) {
      throw new Error(`Stored summary does not match verified evidence for ${manifest.universeId}`);
    }
    await snapshot.assertStable();

    return {
      manifest,
      config,
      replay,
      metrics: structuredClone(metrics),
      summary: verifiedSummary,
    };
  });
}
