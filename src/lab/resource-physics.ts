import {
  PPM,
  type PhysicsState,
  type ResourceKind,
  type ResourceVector,
} from "./types.js";

export const RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze([
  "credits",
  "llmTokens",
  "computeMs",
  "storageBytes",
  "bandwidthBytes",
]);

export interface ResourceMovement {
  source: ResourceVector;
  target: ResourceVector;
}

export class ResourceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceInvariantError";
  }
}

/**
 * Integer-only resource accounting for the laboratory.
 *
 * `spend` is deliberately a transfer into a collector (normally the world
 * treasury), not a subtraction into nowhere. Every successful operation is
 * therefore conservative by construction.
 */
export class ResourcePhysics {
  scaledCost(base: ResourceVector, physics: PhysicsState): ResourceVector {
    assertResourceVector(base, "base cost");
    assertPhysicsState(physics);

    const scaled = emptyResources();
    for (const resource of RESOURCE_KINDS) {
      scaled[resource] = fixedMultiplyCeil(base[resource], physics.resourcePricePpm[resource]);
    }

    if (scaled.bandwidthBytes > 0) {
      if (physics.bandwidthCapacityPpm === 0) {
        throw new ResourceInvariantError("bandwidth capacity is zero");
      }
      scaled.bandwidthBytes = multiplyDivideCeil(
        scaled.bandwidthBytes,
        PPM,
        physics.bandwidthCapacityPpm,
      );
    }
    return scaled;
  }

  canAfford(resources: ResourceVector, cost: ResourceVector): boolean {
    assertResourceVector(resources, "resources");
    assertResourceVector(cost, "cost");
    return RESOURCE_KINDS.every((resource) => resources[resource] >= cost[resource]);
  }

  spend(source: ResourceVector, collector: ResourceVector, cost: ResourceVector): ResourceMovement {
    assertResourceVector(source, "source resources");
    assertResourceVector(collector, "collector resources");
    assertResourceVector(cost, "cost");
    if (!this.canAfford(source, cost)) throw new ResourceInvariantError("insufficient resources");

    const before = [source, collector];
    const nextSource = cloneResources(source);
    const nextCollector = cloneResources(collector);
    for (const resource of RESOURCE_KINDS) {
      nextSource[resource] = safeSubtract(nextSource[resource], cost[resource], resource);
      nextCollector[resource] = safeAdd(nextCollector[resource], cost[resource], resource);
    }
    this.assertConserved(before, [nextSource, nextCollector]);
    return { source: nextSource, target: nextCollector };
  }

  transfer(
    source: ResourceVector,
    target: ResourceVector,
    resource: ResourceKind,
    amount: number,
  ): ResourceMovement {
    assertResourceVector(source, "source resources");
    assertResourceVector(target, "target resources");
    assertNonNegativeSafeInteger(amount, "transfer amount");
    if (!RESOURCE_KINDS.includes(resource)) throw new ResourceInvariantError(`unknown resource ${resource}`);
    if (source[resource] < amount) throw new ResourceInvariantError(`insufficient ${resource}`);

    const nextSource = cloneResources(source);
    const nextTarget = cloneResources(target);
    nextSource[resource] = safeSubtract(nextSource[resource], amount, resource);
    nextTarget[resource] = safeAdd(nextTarget[resource], amount, resource);
    this.assertConserved([source, target], [nextSource, nextTarget]);
    return { source: nextSource, target: nextTarget };
  }

  assertConserved(
    before: ResourceVector | readonly ResourceVector[],
    after: ResourceVector | readonly ResourceVector[],
  ): void {
    const beforeVectors = Array.isArray(before) ? before : [before];
    const afterVectors = Array.isArray(after) ? after : [after];
    for (const [index, vector] of beforeVectors.entries()) assertResourceVector(vector, `before[${index}]`);
    for (const [index, vector] of afterVectors.entries()) assertResourceVector(vector, `after[${index}]`);

    for (const resource of RESOURCE_KINDS) {
      const previous = beforeVectors.reduce((sum, vector) => sum + BigInt(vector[resource]), 0n);
      const current = afterVectors.reduce((sum, vector) => sum + BigInt(vector[resource]), 0n);
      if (previous !== current) {
        throw new ResourceInvariantError(
          `${resource} is not conserved: before=${previous.toString()} after=${current.toString()}`,
        );
      }
    }
  }
}

export function assertResourceVector(resources: ResourceVector, label = "resources"): void {
  for (const resource of RESOURCE_KINDS) {
    assertNonNegativeSafeInteger(resources[resource], `${label}.${resource}`);
  }
}

export function fixedMultiplyFloor(value: number, multiplierPpm: number): number {
  return multiplyDivideFloor(value, multiplierPpm, PPM);
}

export function fixedMultiplyCeil(value: number, multiplierPpm: number): number {
  return multiplyDivideCeil(value, multiplierPpm, PPM);
}

export function multiplyDivideFloor(value: number, multiplier: number, divisor: number): number {
  validateMultiplication(value, multiplier, divisor);
  return safeBigIntToNumber((BigInt(value) * BigInt(multiplier)) / BigInt(divisor), "fixed-point result");
}

export function multiplyDivideCeil(value: number, multiplier: number, divisor: number): number {
  validateMultiplication(value, multiplier, divisor);
  if (value === 0 || multiplier === 0) return 0;
  const numerator = BigInt(value) * BigInt(multiplier);
  const denominator = BigInt(divisor);
  return safeBigIntToNumber((numerator + denominator - 1n) / denominator, "fixed-point result");
}

function assertPhysicsState(physics: PhysicsState): void {
  assertNonNegativeSafeInteger(physics.bandwidthCapacityPpm, "physics.bandwidthCapacityPpm");
  assertNonNegativeSafeInteger(physics.taskLoadPpm, "physics.taskLoadPpm");
  for (const resource of RESOURCE_KINDS) {
    assertNonNegativeSafeInteger(
      physics.resourcePricePpm[resource],
      `physics.resourcePricePpm.${resource}`,
    );
  }
}

function validateMultiplication(value: number, multiplier: number, divisor: number): void {
  assertNonNegativeSafeInteger(value, "fixed-point value");
  assertNonNegativeSafeInteger(multiplier, "fixed-point multiplier");
  if (!Number.isSafeInteger(divisor) || divisor <= 0) {
    throw new ResourceInvariantError("fixed-point divisor must be a positive safe integer");
  }
}

function safeAdd(left: number, right: number, resource: ResourceKind): number {
  return safeBigIntToNumber(BigInt(left) + BigInt(right), `${resource} balance`);
}

function safeSubtract(left: number, right: number, resource: ResourceKind): number {
  const result = left - right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ResourceInvariantError(`${resource} balance would become negative`);
  }
  return result;
}

function safeBigIntToNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ResourceInvariantError(`${label} exceeds the non-negative safe-integer range`);
  }
  return Number(value);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ResourceInvariantError(`${label} must be a non-negative safe integer`);
  }
}

function emptyResources(): ResourceVector {
  return { credits: 0, llmTokens: 0, computeMs: 0, storageBytes: 0, bandwidthBytes: 0 };
}

function cloneResources(resources: ResourceVector): ResourceVector {
  return {
    credits: resources.credits,
    llmTokens: resources.llmTokens,
    computeMs: resources.computeMs,
    storageBytes: resources.storageBytes,
    bandwidthBytes: resources.bandwidthBytes,
  };
}
