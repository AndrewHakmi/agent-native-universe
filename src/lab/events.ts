import type { JsonObject } from "../core/types.js";
import { canonicalJson, hashValue } from "./canonical.js";
import { deterministicId } from "./ids.js";
import {
  LAB_SCHEMA_VERSION,
  type LabEvent,
  type LabEventDraft,
  type LabEventType,
  type RunManifest,
  type TickPhase,
} from "./types.js";

const EVENT_TYPES = new Set<LabEventType>([
  "run.started", "agent.created", "agent.retired", "task.created", "task.claimed", "task.submitted",
  "task.evaluated", "task.expired", "link.created", "link.removed", "link.used", "resource.spent",
  "resource.transferred", "memory.stored", "memory.retrieved", "message.sent", "capability.published",
  "capability.used", "agent.learning.updated", "pressure.applied", "violation.recorded", "metrics.recorded",
  "tick.completed", "run.completed",
]);

const TICK_PHASES = new Set<TickPhase>([
  "genesis", "pressure", "task_generation", "observation", "decision", "resolution", "evaluation",
  "upkeep", "metrics", "checkpoint", "completion",
]);

const EVENT_KEYS = new Set([
  "schemaVersion", "runId", "universeId", "seq", "eventId", "previousHash", "hash", "tick", "phase",
  "type", "data", "actorId", "targetId", "causationId",
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class EventChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventChainError";
  }
}

export interface EventChainVerification {
  events: number;
  lastSeq: number;
  lastTick: number;
  lastHash: string;
}

export function initialEventHash(manifest: RunManifest): string {
  return hashValue({ domain: "agent-native-universe/lab/event-chain/v1", manifest });
}

export function createLabEvent(
  manifest: RunManifest,
  draft: LabEventDraft,
  seq: number,
  previousHash: string,
): LabEvent {
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new RangeError("Event sequence must be a positive safe integer");
  assertDraft(draft);
  if (!HASH_PATTERN.test(previousHash)) throw new TypeError("previousHash must be a lowercase SHA-256 digest");

  const unsigned = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    seq,
    eventId: deterministicId("event", manifest.runId, manifest.universeId, seq),
    previousHash,
    tick: draft.tick,
    phase: draft.phase,
    type: draft.type,
    data: cloneJsonObject(draft.data),
    ...(draft.actorId === undefined ? {} : { actorId: draft.actorId }),
    ...(draft.targetId === undefined ? {} : { targetId: draft.targetId }),
    ...(draft.causationId === undefined ? {} : { causationId: draft.causationId }),
  };
  return { ...unsigned, hash: hashValue(unsigned) };
}

export function computeEventHash(event: LabEvent): string {
  const { hash: _hash, ...unsigned } = event;
  return hashValue(unsigned);
}

export function serializeLabEvent(event: LabEvent): string {
  validateLabEvent(event);
  const expected = computeEventHash(event);
  if (event.hash !== expected) throw new EventChainError(`Event ${event.seq} hash mismatch`);
  return canonicalJson(event);
}

export function deserializeEventJsonl(text: string): LabEvent[] {
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new EventChainError("Event log is truncated: final JSONL newline is missing");
  const lines = text.slice(0, -1).split("\n");
  return lines.map((line, index) => {
    if (line.length === 0) throw new EventChainError(`Event log contains a blank line at ${index + 1}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new EventChainError(`Invalid JSON at event log line ${index + 1}: ${errorMessage(error)}`);
    }
    validateLabEvent(parsed);
    return parsed;
  });
}

export function verifyEventChain(events: readonly LabEvent[], manifest: RunManifest): EventChainVerification {
  let expectedPreviousHash = initialEventHash(manifest);
  let previousTick = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) throw new EventChainError(`Missing event at index ${index}`);
    validateLabEvent(event);
    const expectedSeq = index + 1;
    if (event.seq !== expectedSeq) throw new EventChainError(`Expected event sequence ${expectedSeq}, got ${event.seq}`);
    if (event.runId !== manifest.runId || event.universeId !== manifest.universeId) {
      throw new EventChainError(`Event ${event.seq} belongs to another run or universe`);
    }
    if (event.schemaVersion !== manifest.schemaVersion) throw new EventChainError(`Event ${event.seq} schema mismatch`);
    const expectedId = deterministicId("event", manifest.runId, manifest.universeId, event.seq);
    if (event.eventId !== expectedId) throw new EventChainError(`Event ${event.seq} has a non-deterministic eventId`);
    if (event.previousHash !== expectedPreviousHash) throw new EventChainError(`Event ${event.seq} previousHash mismatch`);
    if (event.tick < previousTick) throw new EventChainError(`Event ${event.seq} moves logical time backwards`);
    const expectedHash = computeEventHash(event);
    if (event.hash !== expectedHash) throw new EventChainError(`Event ${event.seq} hash mismatch`);
    expectedPreviousHash = event.hash;
    previousTick = event.tick;
  }

  return {
    events: events.length,
    lastSeq: events.length,
    lastTick: events.at(-1)?.tick ?? 0,
    lastHash: expectedPreviousHash,
  };
}

function assertDraft(draft: LabEventDraft): void {
  if (!Number.isSafeInteger(draft.tick) || draft.tick < 0) throw new RangeError("Event tick must be a non-negative safe integer");
  if (!TICK_PHASES.has(draft.phase)) throw new TypeError(`Unknown event phase ${String(draft.phase)}`);
  if (!EVENT_TYPES.has(draft.type)) throw new TypeError(`Unknown event type ${String(draft.type)}`);
  assertJsonObject(draft.data, "event data");
  for (const [name, value] of [["actorId", draft.actorId], ["targetId", draft.targetId], ["causationId", draft.causationId]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new TypeError(`${name} must be a non-empty string when present`);
    }
  }
  canonicalJson(draft.data);
}

function validateLabEvent(value: unknown): asserts value is LabEvent {
  assertJsonObject(value, "event");
  for (const key of Object.keys(value)) {
    if (!EVENT_KEYS.has(key)) throw new EventChainError(`Event contains unknown field ${key}`);
  }
  if (value.schemaVersion !== LAB_SCHEMA_VERSION) throw new EventChainError("Unsupported event schema version");
  assertNonEmptyString(value.runId, "runId");
  assertNonEmptyString(value.universeId, "universeId");
  assertPositiveInteger(value.seq, "seq");
  assertNonEmptyString(value.eventId, "eventId");
  assertHash(value.previousHash, "previousHash");
  assertHash(value.hash, "hash");
  if (!Number.isSafeInteger(value.tick) || (value.tick as number) < 0) throw new EventChainError("Invalid event tick");
  if (typeof value.phase !== "string" || !TICK_PHASES.has(value.phase as TickPhase)) throw new EventChainError("Invalid event phase");
  if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type as LabEventType)) throw new EventChainError("Invalid event type");
  assertJsonObject(value.data, "event data");
  for (const key of ["actorId", "targetId", "causationId"] as const) {
    const field = value[key];
    if (field !== undefined) assertNonEmptyString(field, key);
  }
  canonicalJson(value);
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(canonicalJson(value)) as JsonObject;
}

function assertJsonObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EventChainError(`${name} must be a JSON object`);
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new EventChainError(`${name} must be a non-empty string`);
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new EventChainError(`${name} must be a positive safe integer`);
}

function assertHash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new EventChainError(`${name} must be a lowercase SHA-256 digest`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
