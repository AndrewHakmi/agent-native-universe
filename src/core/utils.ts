import { randomUUID } from "node:crypto";
import type { AgentId, JsonObject, JsonValue, LinkId } from "./types.js";
export const agentId = (): AgentId => `na:${randomUUID()}`;
export const linkId = (): LinkId => `lp:${randomUUID()}`;
export function deepClone<T>(value: T): T { return structuredClone(value); }
export function mergeJson(base: JsonObject, delta: JsonObject): JsonObject { const out: JsonObject = deepClone(base); for (const [key, value] of Object.entries(delta)) { if (isObject(value) && isObject(out[key])) out[key] = mergeJson(out[key] as JsonObject, value); else out[key] = deepClone(value); } return out; }
export function isObject(value: JsonValue | undefined): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function assertConfidence(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`confidence must be in [0,1], got ${value}`); }
