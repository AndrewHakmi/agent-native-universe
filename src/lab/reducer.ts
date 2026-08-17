import type { JsonObject, JsonValue } from "../core/types.js";
import {
  LAB_SCHEMA_VERSION,
  PPM,
  ZERO_RESOURCES,
  type CapabilityState,
  type LabAgentState,
  type LabEvent,
  type LabLinkState,
  type LabTaskState,
  type MetricsSnapshot,
  type PhysicsState,
  type PrimitiveActionType,
  type ResourceKind,
  type ResourceVector,
  type RunManifest,
  type SubmissionState,
  type TaskFamily,
  type WorldState,
} from "./types.js";

const RESOURCE_KINDS: readonly ResourceKind[] = [
  "credits", "llmTokens", "computeMs", "storageBytes", "bandwidthBytes",
];

const ACTION_TYPES = new Set<PrimitiveActionType>([
  "observe", "reason", "send", "connect", "disconnect", "store", "retrieve", "execute", "verify",
  "spawn", "clone", "merge", "reserve", "transfer", "trade", "publishCapability", "useCapability",
  "claimTask", "submit",
]);

export function initialWorldState(manifest: RunManifest): WorldState {
  if (manifest.schemaVersion !== LAB_SCHEMA_VERSION) throw new Error("Unsupported lab manifest schema version");
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    configHash: manifest.configHash,
    seed: manifest.seed,
    tick: 0,
    agents: {},
    links: {},
    tasks: {},
    submissions: {},
    capabilities: {},
    physics: defaultPhysics(),
    treasury: cloneResources(ZERO_RESOURCES),
    resourceSpent: cloneResources(ZERO_RESOURCES),
    metrics: [],
    completed: false,
  };
}

/** Pure world projection: the input state and event are never mutated. */
export function reduceWorldEvent(state: WorldState, event: LabEvent): WorldState {
  if (state.schemaVersion !== LAB_SCHEMA_VERSION || event.schemaVersion !== LAB_SCHEMA_VERSION) {
    throw new Error("Unsupported lab schema version");
  }
  if (event.runId !== state.runId || event.universeId !== state.universeId) {
    throw new Error(`Event ${event.seq} belongs to another world`);
  }
  if (event.tick < state.tick) throw new Error(`Event ${event.seq} moves world time backwards`);
  if (state.completed) throw new Error(`Cannot apply event ${event.seq} after run completion`);

  const next = structuredClone(state);
  next.tick = event.tick;
  const data = event.data;

  switch (event.type) {
    case "run.started": {
      const treasury = optionalRecord(data.treasury);
      if (treasury) next.treasury = parseResources(treasury, "run.started treasury");
      const physics = optionalRecord(data.physics);
      if (physics) next.physics = parsePhysics(physics, next.physics);
      break;
    }
    case "agent.created": {
      const agent = parseAgent(optionalRecord(data.agent) ?? data, event);
      if (next.agents[agent.id]) throw new Error(`Agent ${agent.id} already exists`);
      next.agents[agent.id] = agent;
      break;
    }
    case "agent.retired": {
      const agent = requireAgent(next, eventAgentId(event));
      agent.active = false;
      agent.retiredTick = optionalSafeInteger(data.retiredTick, "retiredTick") ?? event.tick;
      break;
    }
    case "task.created": {
      const task = parseTask(optionalRecord(data.task) ?? data);
      if (next.tasks[task.id]) throw new Error(`Task ${task.id} already exists`);
      next.tasks[task.id] = task;
      break;
    }
    case "task.claimed": {
      const task = requireTask(next, requiredString(data.taskId, "taskId"));
      const agentId = eventAgentId(event);
      const agent = requireAgent(next, agentId);
      if (!agent.active) throw new Error(`Inactive agent ${agentId} cannot claim tasks`);
      if (task.status !== "available") throw new Error(`Task ${task.id} is ${task.status}, not available`);
      task.status = "claimed";
      task.claimedBy = agentId;
      break;
    }
    case "task.submitted": {
      const submission = parseSubmission(optionalRecord(data.submission) ?? data, event);
      if (next.submissions[submission.id]) throw new Error(`Submission ${submission.id} already exists`);
      const task = requireTask(next, submission.taskId);
      const agent = requireAgent(next, submission.agentId);
      if (!agent.active) throw new Error(`Inactive agent ${submission.agentId} cannot submit tasks`);
      if (task.status !== "claimed") throw new Error(`Task ${task.id} is ${task.status}, not claimed`);
      if (task.claimedBy !== submission.agentId) {
        throw new Error(`Task ${task.id} is claimed by ${String(task.claimedBy)}, not ${submission.agentId}`);
      }
      next.submissions[submission.id] = submission;
      task.status = "submitted";
      task.submittedBy = submission.agentId;
      break;
    }
    case "task.evaluated": {
      const submission = requireSubmission(next, requiredString(data.submissionId, "submissionId"));
      const task = requireTask(next, optionalString(data.taskId) ?? submission.taskId);
      submission.accepted = requiredBoolean(data.accepted, "accepted");
      submission.qualityPpm = nonNegativeInteger(data.qualityPpm, "qualityPpm");
      submission.latencyTicks = nonNegativeInteger(data.latencyTicks, "latencyTicks");
      task.status = "completed";
      task.completedTick = optionalSafeInteger(data.completedTick, "completedTick") ?? event.tick;
      const agent = requireAgent(next, submission.agentId);
      incrementTask(agent, task.family, submission.accepted);
      break;
    }
    case "task.expired": {
      requireTask(next, requiredString(data.taskId, "taskId")).status = "expired";
      break;
    }
    case "link.created": {
      const link = parseLink(optionalRecord(data.link) ?? data, event);
      if (next.links[link.id]) throw new Error(`Link ${link.id} already exists`);
      requireAgent(next, link.left);
      requireAgent(next, link.right);
      next.links[link.id] = link;
      break;
    }
    case "link.removed": {
      const linkId = requiredString(data.linkId, "linkId");
      if (!next.links[linkId]) throw new Error(`Unknown link ${linkId}`);
      delete next.links[linkId];
      break;
    }
    case "link.used": {
      const link = requireLink(next, requiredString(data.linkId, "linkId"));
      link.lastUsedTick = event.tick;
      const strength = optionalSafeInteger(data.strengthPpm, "strengthPpm");
      if (strength !== undefined) link.strengthPpm = strength;
      break;
    }
    case "resource.spent": {
      const agentId = eventAgentId(event);
      const resources = requireAgent(next, agentId).resources;
      const cost = optionalRecord(data.cost);
      if (cost) {
        const parsed = parseResources(cost, "resource cost");
        for (const kind of RESOURCE_KINDS) {
          debit(resources, kind, parsed[kind], agentId);
          credit(next.treasury, kind, parsed[kind]);
          credit(next.resourceSpent, kind, parsed[kind]);
        }
      } else {
        const resource = parseResourceKind(data.resource);
        const amount = positiveInteger(data.amount, "amount");
        debit(resources, resource, amount, agentId);
        credit(next.treasury, resource, amount);
        credit(next.resourceSpent, resource, amount);
      }
      const action = optionalString(data.action);
      if (action && ACTION_TYPES.has(action as PrimitiveActionType)) incrementAction(next, agentId, action as PrimitiveActionType);
      break;
    }
    case "resource.transferred": {
      const fromId = optionalString(data.fromId) ?? event.actorId ?? "@treasury";
      const toId = optionalString(data.toId) ?? event.targetId ?? "@treasury";
      const resource = parseResourceKind(data.resource);
      const amount = positiveInteger(data.amount, "amount");
      debit(accountResources(next, fromId), resource, amount, fromId);
      credit(accountResources(next, toId), resource, amount);
      break;
    }
    case "memory.stored": {
      const agentId = eventAgentId(event);
      const agent = requireAgent(next, agentId);
      agent.memory[requiredString(data.key, "key")] = cloneJsonValue(requiredJsonValue(data.value, "value"));
      break;
    }
    case "memory.retrieved": {
      requireAgent(next, eventAgentId(event));
      break;
    }
    case "message.sent": {
      requireAgent(next, eventAgentId(event));
      break;
    }
    case "capability.published": {
      const capability = parseCapability(optionalRecord(data.capability) ?? data, event);
      if (next.capabilities[capability.id]) throw new Error(`Capability ${capability.id} already exists`);
      requireAgent(next, capability.ownerId);
      next.capabilities[capability.id] = capability;
      break;
    }
    case "capability.used": {
      const capability = requireCapability(next, requiredString(data.capabilityId, "capabilityId"));
      capability.usageCount += 1;
      if (data.success === true) capability.successCount += 1;
      requireAgent(next, eventAgentId(event));
      break;
    }
    case "agent.learning.updated": {
      const agent = requireAgent(next, eventAgentId(event));
      const learning = optionalRecord(data.learning);
      if (learning) {
        agent.learning = structuredClone(learning) as unknown as LabAgentState["learning"];
      } else {
        const family = requiredString(data.family, "family") as TaskFamily;
        agent.learning.attempts[family] = nonNegativeInteger(data.attempts, "attempts");
        agent.learning.successes[family] = nonNegativeInteger(data.successes, "successes");
        agent.learning.utilityPpm[family] = nonNegativeInteger(data.utilityPpm, "utilityPpm");
      }
      break;
    }
    case "pressure.applied": {
      applyPressure(next, optionalRecord(data.pressure) ?? data);
      break;
    }
    case "violation.recorded": {
      const agent = requireAgent(next, eventAgentId(event));
      agent.violations += optionalSafeInteger(data.count, "count") ?? 1;
      break;
    }
    case "metrics.recorded": {
      const metrics = optionalRecord(data.metrics) ?? data;
      next.metrics.push(structuredClone(metrics) as unknown as MetricsSnapshot);
      break;
    }
    case "tick.completed":
      break;
    case "run.completed":
      next.completed = true;
      break;
  }

  return next;
}

function defaultPhysics(): PhysicsState {
  return {
    resourcePricePpm: {
      credits: PPM,
      llmTokens: PPM,
      computeMs: PPM,
      storageBytes: PPM,
      bandwidthBytes: PPM,
    },
    bandwidthCapacityPpm: PPM,
    taskLoadPpm: PPM,
  };
}

function parsePhysics(value: Record<string, unknown>, fallback: PhysicsState): PhysicsState {
  const prices = optionalRecord(value.resourcePricePpm);
  const resourcePricePpm = structuredClone(fallback.resourcePricePpm);
  if (prices) {
    for (const kind of RESOURCE_KINDS) {
      if (prices[kind] !== undefined) resourcePricePpm[kind] = nonNegativeInteger(prices[kind], `resourcePricePpm.${kind}`);
    }
  }
  return {
    resourcePricePpm,
    bandwidthCapacityPpm: optionalSafeInteger(value.bandwidthCapacityPpm, "bandwidthCapacityPpm") ?? fallback.bandwidthCapacityPpm,
    taskLoadPpm: optionalSafeInteger(value.taskLoadPpm, "taskLoadPpm") ?? fallback.taskLoadPpm,
  };
}

function parseAgent(value: Record<string, unknown>, event: LabEvent): LabAgentState {
  const id = optionalString(value.id) ?? optionalString(value.agentId) ?? event.actorId;
  if (!id) throw new Error("agent.created requires an agent id");
  const resources = optionalRecord(value.resources);
  return {
    id,
    active: value.active === undefined ? true : requiredBoolean(value.active, "agent.active"),
    generation: optionalSafeInteger(value.generation, "agent.generation") ?? 0,
    lineage: stringArray(value.lineage, "agent.lineage"),
    resources: resources ? parseResources(resources, "agent.resources") : cloneResources(ZERO_RESOURCES),
    memory: (structuredClone(optionalRecord(value.memory) ?? {}) as Record<string, JsonValue>),
    learning: (structuredClone(optionalRecord(value.learning) ?? { attempts: {}, successes: {}, utilityPpm: {} }) as unknown as LabAgentState["learning"]),
    actionCounts: (structuredClone(optionalRecord(value.actionCounts) ?? {}) as LabAgentState["actionCounts"]),
    taskCounts: (structuredClone(optionalRecord(value.taskCounts) ?? {}) as LabAgentState["taskCounts"]),
    violations: optionalSafeInteger(value.violations, "agent.violations") ?? 0,
    createdTick: optionalSafeInteger(value.createdTick, "agent.createdTick") ?? event.tick,
    ...(value.retiredTick === undefined ? {} : { retiredTick: nonNegativeInteger(value.retiredTick, "agent.retiredTick") }),
  };
}

function parseTask(value: Record<string, unknown>): LabTaskState {
  const status = optionalString(value.status) ?? "available";
  if (!["available", "claimed", "submitted", "completed", "expired"].includes(status)) throw new Error(`Invalid task status ${status}`);
  return {
    id: requiredString(value.id, "task.id"),
    family: requiredString(value.family, "task.family") as TaskFamily,
    input: cloneJsonValue(requiredJsonValue(value.input, "task.input")),
    createdTick: nonNegativeInteger(value.createdTick, "task.createdTick"),
    deadlineTick: nonNegativeInteger(value.deadlineTick, "task.deadlineTick"),
    status: status as LabTaskState["status"],
    ...(value.claimedBy === undefined ? {} : { claimedBy: requiredString(value.claimedBy, "task.claimedBy") }),
    ...(value.submittedBy === undefined ? {} : { submittedBy: requiredString(value.submittedBy, "task.submittedBy") }),
    ...(value.completedTick === undefined ? {} : { completedTick: nonNegativeInteger(value.completedTick, "task.completedTick") }),
  };
}

function parseSubmission(value: Record<string, unknown>, event: LabEvent): SubmissionState {
  return {
    id: requiredString(value.id, "submission.id"),
    taskId: requiredString(value.taskId, "submission.taskId"),
    agentId: optionalString(value.agentId) ?? event.actorId ?? requiredString(value.agentId, "submission.agentId"),
    result: cloneJsonValue(requiredJsonValue(value.result, "submission.result")),
    submittedTick: optionalSafeInteger(value.submittedTick, "submission.submittedTick") ?? event.tick,
    accepted: value.accepted === undefined ? false : requiredBoolean(value.accepted, "submission.accepted"),
    qualityPpm: optionalSafeInteger(value.qualityPpm, "submission.qualityPpm") ?? 0,
    latencyTicks: optionalSafeInteger(value.latencyTicks, "submission.latencyTicks") ?? 0,
  };
}

function parseLink(value: Record<string, unknown>, event: LabEvent): LabLinkState {
  return {
    id: requiredString(value.id, "link.id"),
    left: requiredString(value.left, "link.left"),
    right: requiredString(value.right, "link.right"),
    strengthPpm: optionalSafeInteger(value.strengthPpm, "link.strengthPpm") ?? PPM,
    createdTick: optionalSafeInteger(value.createdTick, "link.createdTick") ?? event.tick,
    lastUsedTick: optionalSafeInteger(value.lastUsedTick, "link.lastUsedTick") ?? event.tick,
  };
}

function parseCapability(value: Record<string, unknown>, event: LabEvent): CapabilityState {
  const ownerId = optionalString(value.ownerId) ?? event.actorId;
  if (!ownerId) throw new Error("capability.published requires ownerId");
  const cost = optionalRecord(value.cost);
  return {
    id: requiredString(value.id, "capability.id"),
    ownerId,
    version: optionalSafeInteger(value.version, "capability.version") ?? 1,
    inputs: stringArray(value.inputs, "capability.inputs"),
    outputs: stringArray(value.outputs, "capability.outputs"),
    primitivePlan: stringArray(value.primitivePlan, "capability.primitivePlan") as PrimitiveActionType[],
    tests: structuredClone((value.tests ?? []) as JsonValue[]),
    cost: cost ? parseResources(cost, "capability.cost") : cloneResources(ZERO_RESOURCES),
    createdTick: optionalSafeInteger(value.createdTick, "capability.createdTick") ?? event.tick,
    usageCount: optionalSafeInteger(value.usageCount, "capability.usageCount") ?? 0,
    successCount: optionalSafeInteger(value.successCount, "capability.successCount") ?? 0,
  };
}

function applyPressure(state: WorldState, value: Record<string, unknown>): void {
  const type = requiredString(value.type, "pressure.type");
  const resultingPpm = optionalSafeInteger(value.resultingPpm, "pressure.resultingPpm");
  if (type === "resource_price_multiplier") {
    const resource = parseResourceKind(value.resource);
    state.physics.resourcePricePpm[resource] = resultingPpm ?? multiplyPpm(
      state.physics.resourcePricePpm[resource], nonNegativeInteger(value.multiplierPpm, "pressure.multiplierPpm"),
    );
  } else if (type === "bandwidth_capacity_multiplier") {
    state.physics.bandwidthCapacityPpm = resultingPpm ?? multiplyPpm(
      state.physics.bandwidthCapacityPpm, nonNegativeInteger(value.multiplierPpm, "pressure.multiplierPpm"),
    );
  } else if (type === "task_load_multiplier") {
    state.physics.taskLoadPpm = resultingPpm ?? multiplyPpm(
      state.physics.taskLoadPpm, nonNegativeInteger(value.multiplierPpm, "pressure.multiplierPpm"),
    );
  } else if (type !== "retire_agent_fraction") {
    throw new Error(`Unknown pressure type ${type}`);
  }
}

function incrementAction(state: WorldState, agentId: string, action: PrimitiveActionType): void {
  const agent = requireAgent(state, agentId);
  agent.actionCounts[action] = (agent.actionCounts[action] ?? 0) + 1;
}

function incrementTask(agent: LabAgentState, family: TaskFamily, accepted: boolean): void {
  agent.taskCounts[family] = (agent.taskCounts[family] ?? 0) + 1;
  agent.learning.attempts[family] = (agent.learning.attempts[family] ?? 0) + 1;
  if (accepted) agent.learning.successes[family] = (agent.learning.successes[family] ?? 0) + 1;
}

function accountResources(state: WorldState, account: string): ResourceVector {
  if (account === "@treasury" || account === "treasury") return state.treasury;
  return requireAgent(state, account).resources;
}

function debit(resources: ResourceVector, kind: ResourceKind, amount: number, account: string): void {
  if (amount === 0) return;
  if (resources[kind] < amount) throw new Error(`${account} has insufficient ${kind}`);
  resources[kind] -= amount;
}

function credit(resources: ResourceVector, kind: ResourceKind, amount: number): void {
  const next = resources[kind] + amount;
  if (!Number.isSafeInteger(next)) throw new Error(`${kind} balance exceeds safe integer range`);
  resources[kind] = next;
}

function parseResources(value: Record<string, unknown>, name: string): ResourceVector {
  return {
    credits: nonNegativeInteger(value.credits, `${name}.credits`),
    llmTokens: nonNegativeInteger(value.llmTokens, `${name}.llmTokens`),
    computeMs: nonNegativeInteger(value.computeMs, `${name}.computeMs`),
    storageBytes: nonNegativeInteger(value.storageBytes, `${name}.storageBytes`),
    bandwidthBytes: nonNegativeInteger(value.bandwidthBytes, `${name}.bandwidthBytes`),
  };
}

function cloneResources(value: Readonly<ResourceVector>): ResourceVector {
  return { ...value };
}

function parseResourceKind(value: unknown): ResourceKind {
  if (typeof value !== "string" || !(RESOURCE_KINDS as readonly string[]).includes(value)) throw new Error(`Unknown resource ${String(value)}`);
  return value as ResourceKind;
}

function eventAgentId(event: LabEvent): string {
  return optionalString(event.data.agentId) ?? event.actorId ?? (() => { throw new Error(`${event.type} requires an agent id`); })();
}

function requireAgent(state: WorldState, id: string): LabAgentState {
  const agent = state.agents[id];
  if (!agent) throw new Error(`Unknown agent ${id}`);
  return agent;
}

function requireTask(state: WorldState, id: string): LabTaskState {
  const task = state.tasks[id];
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}

function requireSubmission(state: WorldState, id: string): SubmissionState {
  const submission = state.submissions[id];
  if (!submission) throw new Error(`Unknown submission ${id}`);
  return submission;
}

function requireLink(state: WorldState, id: string): LabLinkState {
  const link = state.links[id];
  if (!link) throw new Error(`Unknown link ${id}`);
  return link;
}

function requireCapability(state: WorldState, id: string): CapabilityState {
  const capability = state.capabilities[id];
  if (!capability) throw new Error(`Unknown capability ${id}`);
  return capability;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${name} must be a non-empty string`);
  return parsed;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function optionalSafeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return nonNegativeInteger(value, name);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function requiredJsonValue(value: unknown, name: string): JsonValue {
  if (value === undefined) throw new Error(`${name} is required`);
  return value as JsonValue;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name} must be a string array`);
  return [...value] as string[];
}

function multiplyPpm(value: number, multiplierPpm: number): number {
  const result = (BigInt(value) * BigInt(multiplierPpm)) / BigInt(PPM);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PPM multiplication exceeds safe integer range");
  return Number(result);
}
