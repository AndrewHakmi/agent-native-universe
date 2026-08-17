import type { Observation, TaskObservation, WorldState } from "./types.js";
import { compareCodeUnits } from "./canonical.js";

/** Builds the complete information boundary visible to one agent. */
export function observeWorld(state: WorldState, agentId: string): Observation {
  const agent = state.agents[agentId];
  if (!agent) throw new Error(`Unknown agent ${agentId}`);

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
      cost: { ...capability.cost },
    }));

  const observation: Observation = {
    tick: state.tick,
    agentId,
    resources: { ...agent.resources },
    tasks,
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
  const forbidden = new Set(["oracle", "expected", "expectedResult", "solution", "privateState"]);
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      if (forbidden.has(key)) throw new Error(`Observation leaks forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
}
