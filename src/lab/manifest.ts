import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { deterministicId } from "./ids.js";
import type { GenesisConfig, RunManifest } from "./types.js";

export const LAB_ENGINE_VERSION = "genesis-logical-v1.0.0";
export const LAB_POLICY_ID = "neutral-backpressure-v1";
export const LAB_TASK_GENERATOR_ID = "deterministic-task-stream-v1";

export function createRunManifest(config: GenesisConfig, universeId: string): RunManifest {
  validateGenesisConfig(config);
  if (!/^U[0-9]{4,8}$/.test(universeId)) {
    throw new Error("Universe id must match U0001-style notation");
  }
  const configHash = hashValue(config);
  const implementation = {
    engineVersion: LAB_ENGINE_VERSION,
    mode: "logical" as const,
    policyId: LAB_POLICY_ID,
    taskGeneratorId: LAB_TASK_GENERATOR_ID,
  };
  return {
    schemaVersion: config.schemaVersion,
    experimentId: config.experimentId,
    ...implementation,
    runId: deterministicId(
      "run",
      config.experimentId,
      universeId,
      config.seed,
      configHash,
      hashValue(implementation),
    ).replace(":", "-"),
    universeId,
    seed: config.seed,
    configHash,
  };
}

export function populationSeed(baseSeed: string, universeId: string): string {
  if (!baseSeed) throw new Error("Population seed must not be empty");
  if (!/^U[0-9]{4,8}$/.test(universeId)) throw new Error("Invalid population universe id");
  return deterministicId("seed", baseSeed, universeId);
}
