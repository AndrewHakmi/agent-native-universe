import { randomUUID } from "node:crypto";
import type { AgentId, JsonObject, JsonValue, LinkId, NegotiationId, ProbationPolicy, ProtocolPatch, ProtocolTerms } from "./types.js";

export const agentId = (): AgentId => `na:${randomUUID()}`;
export const linkId = (): LinkId => `lp:${randomUUID()}`;
export const negotiationId = (): NegotiationId => `ng:${randomUUID()}`;
export const pairKey = (a: AgentId, b: AgentId): string => [a, b].sort().join("::");

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function mergeJson(base: JsonObject, delta: JsonObject): JsonObject {
  const out: JsonObject = deepClone(base);
  for (const [key, value] of Object.entries(delta)) {
    if (isObject(value) && isObject(out[key])) out[key] = mergeJson(out[key] as JsonObject, value);
    else out[key] = deepClone(value);
  }
  return out;
}

export function diffJson(base: JsonObject, next: JsonObject): JsonObject {
  const delta: JsonObject = {};
  for (const [key, value] of Object.entries(next)) {
    const previous = base[key];
    if (isObject(value) && isObject(previous)) {
      const child = diffJson(previous as JsonObject, value);
      if (Object.keys(child).length > 0) delta[key] = child;
      continue;
    }
    if (!deepEqual(previous, value)) delta[key] = deepClone(value);
  }
  return delta;
}

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`confidence must be in [0,1], got ${value}`);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function tokenize(...values: string[]): Set<string> {
  return new Set(values.join(" ").toLowerCase().split(/[^a-z0-9_.:-]+/u).filter(token => token.length > 1));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function intersect(a: string[], b: string[]): string[] {
  const right = new Set(b);
  return unique(a.filter(value => right.has(value)));
}

export function applyProtocolPatch(base: ProtocolTerms, patch: ProtocolPatch): ProtocolTerms {
  const probation: ProbationPolicy = {
    requiredInteractions: patch.probation?.requiredInteractions ?? base.probation.requiredInteractions,
    minStrength: patch.probation?.minStrength ?? base.probation.minStrength,
    timeoutMs: patch.probation?.timeoutMs ?? base.probation.timeoutMs
  };
  return {
    mode: patch.mode ?? base.mode,
    fieldOwnership: patch.fieldOwnership ? { ...base.fieldOwnership, ...patch.fieldOwnership } : { ...base.fieldOwnership },
    payloadMode: patch.payloadMode ?? base.payloadMode,
    activationMode: patch.activationMode ?? base.activationMode,
    minActivationIntervalMs: patch.minActivationIntervalMs ?? base.minActivationIntervalMs,
    heartbeatMs: patch.heartbeatMs ?? base.heartbeatMs,
    triggers: patch.triggers ? unique(patch.triggers) : [...base.triggers],
    minInformationGain: patch.minInformationGain ?? base.minInformationGain,
    maxCommunicationCost: patch.maxCommunicationCost ?? base.maxCommunicationCost,
    decayRate: patch.decayRate ?? base.decayRate,
    maxIdleMs: patch.maxIdleMs ?? base.maxIdleMs,
    retireBelowStrength: patch.retireBelowStrength ?? base.retireBelowStrength,
    reviewEveryRevisions: patch.reviewEveryRevisions ?? base.reviewEveryRevisions,
    probation
  };
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
