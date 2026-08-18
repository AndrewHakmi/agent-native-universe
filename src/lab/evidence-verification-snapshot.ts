import type { ReplayResult } from "./replay.js";
import type {
  GenesisConfig,
  MetricsSnapshot,
  RunManifest,
  RunSummary,
} from "./types.js";

export interface EvidenceVerificationSnapshot {
  readManifest(): Promise<RunManifest>;
  readConfig(manifest: RunManifest): Promise<GenesisConfig>;
  replay(manifest: RunManifest, config: GenesisConfig): Promise<ReplayResult>;
  readMetrics(): Promise<MetricsSnapshot[]>;
  readSummary(manifest: RunManifest): Promise<RunSummary>;
  assertStable(): Promise<void>;
}

interface EvidenceVerificationSnapshotProvider {
  <T>(operation: (snapshot: EvidenceVerificationSnapshot) => Promise<T>): Promise<T>;
}

const snapshotProviders = new WeakMap<object, EvidenceVerificationSnapshotProvider>();

/** @internal Register the fd-held snapshot provider owned by EvidenceStore. */
export function registerEvidenceVerificationSnapshotProvider(
  store: object,
  provider: EvidenceVerificationSnapshotProvider,
): void {
  if (snapshotProviders.has(store)) {
    throw new Error("Evidence verification snapshot provider is already registered");
  }
  snapshotProviders.set(store, provider);
}

/** @internal Run verification against one set of held artifact handles. */
export async function withEvidenceVerificationSnapshotInternal<T>(
  store: object,
  operation: (snapshot: EvidenceVerificationSnapshot) => Promise<T>,
): Promise<T> {
  const provider = snapshotProviders.get(store);
  if (provider === undefined) throw new TypeError("Unsupported evidence store instance");
  return provider(operation);
}
