import type { JsonObject, JsonValue } from "../core/types.js";

export const LAB_SCHEMA_VERSION = 1 as const;
export const PPM = 1_000_000;

export type PrimitiveActionType =
  | "observe"
  | "reason"
  | "send"
  | "connect"
  | "disconnect"
  | "store"
  | "retrieve"
  | "execute"
  | "verify"
  | "spawn"
  | "clone"
  | "merge"
  | "reserve"
  | "transfer"
  | "trade"
  | "publishCapability"
  | "useCapability"
  | "claimTask"
  | "submit";

export type ResourceKind =
  | "credits"
  | "llmTokens"
  | "computeMs"
  | "storageBytes"
  | "bandwidthBytes";

export interface ResourceVector {
  credits: number;
  llmTokens: number;
  computeMs: number;
  storageBytes: number;
  bandwidthBytes: number;
}

export type TaskFamily =
  | "arithmetic"
  | "json_transform"
  | "memory_recall"
  | "correlation"
  | "verification"
  | "multi_step"
  | "concurrency"
  | "state_recovery";

export type TaskStatus = "available" | "claimed" | "submitted" | "completed" | "expired";

export interface TaskStreamConfig {
  families: TaskFamily[];
  tasksPerTick: number;
  deadlineTicks: number;
  maxBacklog: number;
}

export type PressureSpec =
  | { tick: number; type: "resource_price_multiplier"; resource: ResourceKind; multiplierPpm: number }
  | { tick: number; type: "bandwidth_capacity_multiplier"; multiplierPpm: number }
  | { tick: number; type: "retire_agent_fraction"; fractionPpm: number }
  | { tick: number; type: "task_load_multiplier"; multiplierPpm: number };

export interface GenesisConfig {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: "genesis-1";
  seed: string;
  ticks: number;
  agents: number;
  metricEvery: number;
  checkpointEvery: number;
  initialResources: ResourceVector;
  treasuryResources: ResourceVector;
  acceptedTaskReward: ResourceVector;
  costs: Record<PrimitiveActionType, ResourceVector>;
  taskStream: TaskStreamConfig;
  pressures: PressureSpec[];
}

export interface RunManifest {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: string;
  engineVersion: string;
  mode: "logical";
  policyId: string;
  taskGeneratorId: string;
  runId: string;
  universeId: string;
  seed: string;
  configHash: string;
}

export interface AgentLearningState {
  attempts: Partial<Record<TaskFamily, number>>;
  successes: Partial<Record<TaskFamily, number>>;
  utilityPpm: Partial<Record<TaskFamily, number>>;
}

export interface LabAgentState {
  id: string;
  active: boolean;
  generation: number;
  lineage: string[];
  resources: ResourceVector;
  memory: Record<string, JsonValue>;
  learning: AgentLearningState;
  actionCounts: Partial<Record<PrimitiveActionType, number>>;
  taskCounts: Partial<Record<TaskFamily, number>>;
  violations: number;
  createdTick: number;
  retiredTick?: number;
}

export interface LabLinkState {
  id: string;
  left: string;
  right: string;
  strengthPpm: number;
  createdTick: number;
  lastUsedTick: number;
}

export interface LabTaskState {
  id: string;
  family: TaskFamily;
  input: JsonValue;
  createdTick: number;
  deadlineTick: number;
  status: TaskStatus;
  claimedBy?: string;
  submittedBy?: string;
  completedTick?: number;
}

export interface SubmissionState {
  id: string;
  taskId: string;
  agentId: string;
  result: JsonValue;
  submittedTick: number;
  accepted: boolean;
  qualityPpm: number;
  latencyTicks: number;
}

export interface CapabilityState {
  id: string;
  ownerId: string;
  version: number;
  inputs: string[];
  outputs: string[];
  primitivePlan: PrimitiveActionType[];
  tests: JsonValue[];
  cost: ResourceVector;
  createdTick: number;
  usageCount: number;
  successCount: number;
}

export interface PhysicsState {
  resourcePricePpm: Record<ResourceKind, number>;
  bandwidthCapacityPpm: number;
  taskLoadPpm: number;
}

export interface WorldState {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  configHash: string;
  seed: string;
  tick: number;
  agents: Record<string, LabAgentState>;
  links: Record<string, LabLinkState>;
  tasks: Record<string, LabTaskState>;
  submissions: Record<string, SubmissionState>;
  capabilities: Record<string, CapabilityState>;
  physics: PhysicsState;
  treasury: ResourceVector;
  resourceSpent: ResourceVector;
  metrics: MetricsSnapshot[];
  completed: boolean;
}

export interface TaskObservation {
  id: string;
  family: TaskFamily;
  input: JsonValue;
  createdTick: number;
  deadlineTick: number;
  status: TaskStatus;
  claimedBy?: string;
}

export interface Observation {
  tick: number;
  agentId: string;
  resources: ResourceVector;
  tasks: TaskObservation[];
  visibleAgents: string[];
  neighbors: string[];
  capabilities: Array<Pick<CapabilityState, "id" | "ownerId" | "inputs" | "outputs" | "cost">>;
  physics: PhysicsState;
}

export type WorldAction =
  | { type: "observe" }
  | { type: "reason"; subject: string }
  | { type: "claimTask"; taskId: string }
  | { type: "execute"; taskId: string; result: JsonValue }
  | { type: "submit"; taskId: string; result: JsonValue }
  | { type: "verify"; submissionId: string }
  | { type: "send"; targetId: string; payload: JsonObject }
  | { type: "connect"; targetId: string }
  | { type: "disconnect"; targetId: string }
  | { type: "store"; key: string; value: JsonValue }
  | { type: "retrieve"; key: string }
  | {
      type: "publishCapability";
      capability: Pick<CapabilityState, "id" | "inputs" | "outputs" | "primitivePlan" | "tests" | "cost">;
    }
  | { type: "useCapability"; capabilityId: string; input: JsonValue }
  | { type: "transfer"; targetId: string; resource: ResourceKind; amount: number }
  | { type: "reserve"; resource: ResourceKind; amount: number }
  | { type: "trade"; resource: ResourceKind; amount: number; credits: number }
  | { type: "spawn" }
  | { type: "clone" }
  | { type: "merge"; targetId: string };

export interface ActionResult {
  accepted: boolean;
  action: PrimitiveActionType;
  data: JsonObject;
  cost: ResourceVector;
  violation?: string;
}

export interface Evaluation {
  taskId: string;
  submissionId: string;
  accepted: boolean;
  qualityPpm: number;
  latencyTicks: number;
  violations: number;
}

export interface MetricsSnapshot {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  tick: number;
  tasksCreated: number;
  tasksCompleted: number;
  taskSuccessRatePpm: number;
  meanQualityPpm: number;
  p50LatencyTicks: number;
  p95LatencyTicks: number;
  creditsPerAcceptedTaskPpm: number;
  computePerAcceptedTaskPpm: number;
  bandwidthPerAcceptedTaskPpm: number;
  activeAgents: number;
  activeLinks: number;
  densityPpm: number;
  connectedComponents: number;
  degreeCentralizationPpm: number;
  resourceGiniPpm: number;
  meanSpecializationPpm: number;
  linkTurnover: number;
  violations: number;
}

export type LabEventType =
  | "run.started"
  | "agent.created"
  | "agent.retired"
  | "task.created"
  | "task.claimed"
  | "task.submitted"
  | "task.evaluated"
  | "task.expired"
  | "link.created"
  | "link.removed"
  | "link.used"
  | "resource.spent"
  | "resource.transferred"
  | "memory.stored"
  | "memory.retrieved"
  | "message.sent"
  | "capability.published"
  | "capability.used"
  | "agent.learning.updated"
  | "pressure.applied"
  | "violation.recorded"
  | "metrics.recorded"
  | "tick.completed"
  | "run.completed";

export interface LabEventDraft {
  tick: number;
  phase: TickPhase;
  type: LabEventType;
  data: JsonObject;
  actorId?: string;
  targetId?: string;
  causationId?: string;
}

export interface LabEvent extends LabEventDraft {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  seq: number;
  eventId: string;
  previousHash: string;
  hash: string;
}

export type TickPhase =
  | "genesis"
  | "pressure"
  | "task_generation"
  | "observation"
  | "decision"
  | "resolution"
  | "evaluation"
  | "upkeep"
  | "metrics"
  | "checkpoint"
  | "completion";

export interface Checkpoint {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  tick: number;
  seq: number;
  eventHash: string;
  stateHash: string;
  state: WorldState;
}

export interface RunSummary {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  runId: string;
  universeId: string;
  seed: string;
  ticks: number;
  events: number;
  finalStateHash: string;
  finalEventHash: string;
  latestMetrics: MetricsSnapshot;
}

export interface PopulationSummary {
  schemaVersion: typeof LAB_SCHEMA_VERSION;
  experimentId: string;
  baseSeed: string;
  universes: RunSummary[];
}

export const ZERO_RESOURCES: Readonly<ResourceVector> = Object.freeze({
  credits: 0,
  llmTokens: 0,
  computeMs: 0,
  storageBytes: 0,
  bandwidthBytes: 0,
});
