import type { JsonObject, JsonValue } from "../core/types.js";
import type {
  MessageObservation,
  Observation,
  SubmissionObservation,
  TaskObservation,
  WorldState,
} from "./types.js";
import { compareCodeUnits } from "./canonical.js";
import { deterministicId } from "./ids.js";

const FORBIDDEN_OBSERVATION_FIELDS = new Set([
  "oracle", "expected", "expectedResult", "solution", "privateState",
  "evaluatorAccepted", "qualityPpm",
]);

// Observation bandwidth is part of the logical physics. These fixed windows
// prevent historical mail and submissions from making every later tick grow.
export const PUBLIC_SUBMISSION_WINDOW = 64;
export const PUBLIC_INBOX_WINDOW = 64;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

interface ObservationFrameInboxEntry {
  readonly messageId: string;
  readonly message?: DeepReadonly<MessageObservation>;
}

interface ObservationFrameAgent {
  readonly resources: DeepReadonly<Observation["resources"]>;
  readonly inbox: readonly ObservationFrameInboxEntry[];
  readonly verifiedSubmissionIds: readonly string[];
}

/**
 * Tick-local public projection shared by every agent observation.
 *
 * The frame is a deeply frozen, redacted snapshot. It owns every reachable
 * value and never retains the mutable WorldState. Building it scans the full
 * task archive once instead of once per active agent.
 */
export interface ObservationFrame {
  readonly tick: number;
  readonly activeAgentIds: readonly string[];
  readonly agentsById: Readonly<Record<string, ObservationFrameAgent>>;
  readonly visibleTasks: readonly DeepReadonly<TaskObservation>[];
  readonly publicSubmissions: readonly DeepReadonly<SubmissionObservation>[];
  readonly neighborsByAgent: Readonly<Record<string, readonly string[]>>;
  readonly capabilities: DeepReadonly<Observation["capabilities"]>;
  readonly physics: DeepReadonly<Observation["physics"]>;
}

/** Builds the complete information boundary visible to one agent. */
export function observeWorld(state: WorldState, agentId: string, observationTick = state.tick): Observation {
  requireAgent(state, agentId);
  validateObservationTick(state, observationTick);
  return observeWorldFromFrame(createObservationFrame(state, observationTick), agentId);
}

/** Build the shared, redacted public projection for one logical tick. */
export function createObservationFrame(
  state: WorldState,
  observationTick = state.tick,
): ObservationFrame {
  validateObservationTick(state, observationTick);

  const agents = Object.values(state.agents);
  const activeAgentIds = agents
    .filter((agent) => agent.active)
    .map((agent) => agent.id)
    .sort(compareCodeUnits);
  const visibleTasks = Object.values(state.tasks)
    .filter((task) => task.status === "available" || task.claimedBy !== undefined)
    .sort((left, right) => left.createdTick - right.createdTick || compareCodeUnits(left.id, right.id))
    .map(toTaskObservation);

  const neighborsByAgent: Record<string, string[]> = {};
  for (const link of Object.values(state.links)) {
    (neighborsByAgent[link.left] ??= []).push(link.right);
    if (link.right !== link.left) (neighborsByAgent[link.right] ??= []).push(link.left);
  }
  for (const neighbors of Object.values(neighborsByAgent)) neighbors.sort(compareCodeUnits);

  const capabilities = Object.values(state.capabilities)
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map(capability => ({
      id: capability.id,
      ownerId: capability.ownerId,
      inputs: [...capability.inputs],
      outputs: [...capability.outputs],
      tests: capability.tests.map((test) => redactValue(structuredClone(test), "", [])),
      cost: { ...capability.cost },
    }));

  const publicSubmissions = state.submissionOrder
    .slice(-PUBLIC_SUBMISSION_WINDOW)
    .map((submissionId) => requireSubmission(state, submissionId))
    .map((submission): SubmissionObservation => ({
      id: submission.id,
      taskId: submission.taskId,
      agentId: submission.agentId,
      result: redactValue(structuredClone(submission.result), "", []),
      submittedTick: submission.submittedTick,
      task: toTaskObservation(requireTask(state, submission.taskId)),
    }));

  const agentsById: Record<string, ObservationFrameAgent> = {};
  for (const agent of agents) {
    const verifiedSubmissionIds = publicSubmissions
      .filter((submission) => (
        state.verifications[deterministicId("verification", state.runId, submission.id, agent.id)] !== undefined
      ))
      .map((submission) => submission.id);
    agentsById[agent.id] = {
      resources: { ...agent.resources },
      inbox: agent.inbox.slice(-PUBLIC_INBOX_WINDOW).map((messageId) => (
        snapshotInboxEntry(state, agent.id, messageId)
      )),
      verifiedSubmissionIds,
    };
  }

  return deepFreezeSnapshot({
    tick: observationTick,
    activeAgentIds,
    agentsById,
    visibleTasks,
    publicSubmissions,
    neighborsByAgent,
    capabilities,
    physics: structuredClone(state.physics),
  });
}

/** Materialize one agent-specific view from a shared tick frame. */
export function observeWorldFromFrame(frame: ObservationFrame, agentId: string): Observation {
  const agent = frame.agentsById[agentId];
  if (!agent) throw new Error(`Unknown agent ${agentId}`);

  const tasks = frame.visibleTasks
    .filter((task) => task.status === "available" || task.claimedBy === agentId)
    .map(cloneTaskSnapshot);
  const submissions = frame.publicSubmissions
    .filter((submission) => (
      submission.agentId !== agentId
      && !agent.verifiedSubmissionIds.includes(submission.id)
    ))
    .map(cloneSubmissionSnapshot);

  const invalidInboxEntry = agent.inbox.find((entry) => entry.message === undefined);
  if (invalidInboxEntry) {
    throw new Error(`Inbox ${agentId} contains invalid message ${invalidInboxEntry.messageId}`);
  }
  const inbox = agent.inbox.map((entry) => cloneMessageSnapshot(entry.message!));

  const observation: Observation = {
    tick: frame.tick,
    agentId,
    resources: { ...agent.resources },
    tasks,
    submissions,
    inbox,
    visibleAgents: frame.activeAgentIds.filter((candidateId) => candidateId !== agentId),
    neighbors: [...(frame.neighborsByAgent[agentId] ?? [])],
    capabilities: frame.capabilities.map((capability) => ({
      id: capability.id,
      ownerId: capability.ownerId,
      inputs: [...capability.inputs],
      outputs: [...capability.outputs],
      tests: capability.tests.map(cloneJsonSnapshot),
      cost: { ...capability.cost },
    })),
    physics: {
      resourcePricePpm: { ...frame.physics.resourcePricePpm },
      bandwidthCapacityPpm: frame.physics.bandwidthCapacityPpm,
      taskLoadPpm: frame.physics.taskLoadPpm,
    },
  };
  assertNoOracleLeak(observation);
  return observation;
}

function validateObservationTick(state: WorldState, observationTick: number): void {
  if (!Number.isSafeInteger(observationTick) || observationTick < state.tick) {
    throw new Error("Observation tick must be a safe integer at or after projected world time");
  }
}

function requireAgent(state: WorldState, agentId: string): WorldState["agents"][string] {
  const agent = state.agents[agentId];
  if (!agent) throw new Error(`Unknown agent ${agentId}`);
  return agent;
}

function snapshotInboxEntry(
  state: WorldState,
  agentId: string,
  messageId: string,
): ObservationFrameInboxEntry {
  const message = state.messages[messageId];
  if (!message || message.recipientId !== agentId || message.deliveredTick === undefined) {
    return { messageId };
  }
  const redactedPaths: string[] = [];
  const payload = redactObject(message.payload, "", redactedPaths);
  return {
    messageId,
    message: {
      id: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      payload,
      sentTick: message.sentTick,
      deliveredTick: message.deliveredTick,
      redactedPaths,
    },
  };
}

function deepFreezeSnapshot<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeSnapshot(nested);
  }
  return value as DeepReadonly<T>;
}

function cloneTaskSnapshot(task: DeepReadonly<TaskObservation>): TaskObservation {
  return {
    id: task.id,
    family: task.family,
    input: cloneJsonSnapshot(task.input),
    createdTick: task.createdTick,
    deadlineTick: task.deadlineTick,
    status: task.status,
    ...(task.claimedBy === undefined ? {} : { claimedBy: task.claimedBy }),
  };
}

function cloneSubmissionSnapshot(
  submission: DeepReadonly<SubmissionObservation>,
): SubmissionObservation {
  return {
    id: submission.id,
    taskId: submission.taskId,
    agentId: submission.agentId,
    result: cloneJsonSnapshot(submission.result),
    submittedTick: submission.submittedTick,
    task: cloneTaskSnapshot(submission.task),
  };
}

function cloneMessageSnapshot(message: DeepReadonly<MessageObservation>): MessageObservation {
  return {
    id: message.id,
    senderId: message.senderId,
    recipientId: message.recipientId,
    payload: cloneJsonSnapshot(message.payload) as JsonObject,
    sentTick: message.sentTick,
    deliveredTick: message.deliveredTick,
    redactedPaths: [...message.redactedPaths],
  };
}

function cloneJsonSnapshot(value: DeepReadonly<JsonValue>): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonSnapshot);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonSnapshot(entry)]),
    ) as JsonObject;
  }
  return value;
}

function toTaskObservation(task: WorldState["tasks"][string]): TaskObservation {
  return {
    id: task.id,
    family: task.family,
    input: structuredClone(task.input),
    createdTick: task.createdTick,
    deadlineTick: task.deadlineTick,
    status: task.status,
    ...(task.claimedBy === undefined ? {} : { claimedBy: task.claimedBy }),
  };
}

export function assertNoOracleLeak(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      if (FORBIDDEN_OBSERVATION_FIELDS.has(key)) throw new Error(`Observation leaks forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
}

function redactObject(value: JsonObject, path: string, redactedPaths: string[]): JsonObject {
  return redactValue(value, path, redactedPaths) as JsonObject;
}

function redactValue(value: JsonValue, path: string, redactedPaths: string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue(entry, `${path}/${index}`, redactedPaths));
  }
  if (value !== null && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${path}/${escapeJsonPointer(key)}`;
      if (FORBIDDEN_OBSERVATION_FIELDS.has(key)) {
        redactedPaths.push(childPath);
        continue;
      }
      output[key] = redactValue(entry, childPath, redactedPaths);
    }
    return output;
  }
  return value;
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function requireTask(state: WorldState, taskId: string): WorldState["tasks"][string] {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Submission references unknown task ${taskId}`);
  return task;
}

function requireSubmission(state: WorldState, submissionId: string): WorldState["submissions"][string] {
  const submission = state.submissions[submissionId];
  if (!submission) throw new Error(`Submission order references unknown submission ${submissionId}`);
  return submission;
}
