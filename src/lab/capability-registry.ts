import type { CapabilityState, PrimitiveActionType, ResourceVector } from "./types.js";

const NON_COMPOSABLE = new Set<PrimitiveActionType>([
  "spawn",
  "clone",
  "merge",
  "publishCapability",
  "useCapability",
  "trade",
]);

export interface CapabilityPublication {
  id: string;
  inputs: string[];
  outputs: string[];
  primitivePlan: PrimitiveActionType[];
  tests: unknown[];
  cost: ResourceVector;
}

/**
 * Capabilities are data-defined compositions of primitives, never executable
 * source strings. This keeps the first experiment deterministic and prevents
 * publication from becoming an arbitrary-code escape hatch.
 */
export function validateCapabilityPublication(publication: CapabilityPublication): void {
  if (!/^cap:\/\/[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/.test(publication.id)) {
    throw new Error("Capability id must match cap://name/vN");
  }
  if (publication.inputs.length === 0 || publication.outputs.length === 0) {
    throw new Error("Capability must declare inputs and outputs");
  }
  if (publication.primitivePlan.length === 0) throw new Error("Capability primitive plan must not be empty");
  for (const primitive of publication.primitivePlan) {
    if (NON_COMPOSABLE.has(primitive)) throw new Error(`Primitive ${primitive} cannot appear in a capability plan`);
  }
  if (publication.tests.length === 0) throw new Error("Capability must include at least one observable test vector");
  for (const [kind, amount] of Object.entries(publication.cost)) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Invalid capability cost ${kind}`);
  }
}

export function createCapabilityState(
  ownerId: string,
  tick: number,
  publication: CapabilityPublication,
): CapabilityState {
  validateCapabilityPublication(publication);
  const version = Number.parseInt(publication.id.match(/\/v([1-9][0-9]*)$/)?.[1] ?? "", 10);
  return {
    id: publication.id,
    ownerId,
    version,
    inputs: [...publication.inputs],
    outputs: [...publication.outputs],
    primitivePlan: [...publication.primitivePlan],
    tests: structuredClone(publication.tests) as CapabilityState["tests"],
    cost: { ...publication.cost },
    createdTick: tick,
    usageCount: 0,
    successCount: 0,
  };
}
