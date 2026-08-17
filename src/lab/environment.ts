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

/** Builds the complete information boundary visible to one agent. */
export function observeWorld(state: WorldState, agentId: string, observationTick = state.tick): Observation {
  const agent = state.agents[agentId];
  if (!agent) throw new Error(`Unknown agent ${agentId}`);
  if (!Number.isSafeInteger(observationTick) || observationTick < state.tick) {
    throw new Error("Observation tick must be a safe integer at or after projected world time");
  }

  const tasks = Object.values(state.tasks)
    .filter(task => task.status === "available" || task.claimedBy === agentId)
    .sort((left, right) => left.createdTick - right.createdTick || compareCodeUnits(left.id, right.id))
    .map(toTaskObservation);

  const neighbors = Object.values(state.links)
    .filter(link => link.left === agentId || link.right === agentId)
    .map(link => link.left === agentId ? link.right : link.left)
    .sort();

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

  const submissions = state.submissionOrder
    .slice(-PUBLIC_SUBMISSION_WINDOW)
    .map((submissionId) => requireSubmission(state, submissionId))
    .filter((submission) => (
      submission.agentId !== agentId
      && !state.verifications[deterministicId("verification", state.runId, submission.id, agentId)]
    ))
    .map((submission): SubmissionObservation => ({
      id: submission.id,
      taskId: submission.taskId,
      agentId: submission.agentId,
      result: redactValue(structuredClone(submission.result), "", []),
      submittedTick: submission.submittedTick,
      task: toTaskObservation(requireTask(state, submission.taskId)),
    }));

  const inbox = agent.inbox.slice(-PUBLIC_INBOX_WINDOW).map((messageId): MessageObservation => {
    const message = state.messages[messageId];
    if (!message || message.recipientId !== agentId || message.deliveredTick === undefined) {
      throw new Error(`Inbox ${agentId} contains invalid message ${messageId}`);
    }
    const redactedPaths: string[] = [];
    const payload = redactObject(message.payload, "", redactedPaths);
    return {
      id: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      payload,
      sentTick: message.sentTick,
      deliveredTick: message.deliveredTick,
      redactedPaths,
    };
  });

  const observation: Observation = {
    tick: observationTick,
    agentId,
    resources: { ...agent.resources },
    tasks,
    submissions,
    inbox,
    visibleAgents: Object.values(state.agents)
      .filter(candidate => candidate.active && candidate.id !== agentId)
      .map(candidate => candidate.id)
      .sort(),
    neighbors,
    capabilities,
    physics: structuredClone(state.physics),
  };
  assertNoOracleLeak(observation);
  return observation;
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
