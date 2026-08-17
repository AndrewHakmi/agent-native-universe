import type { GenesisConfig, LabAgentState } from "./types.js";

/**
 * Creates a role-neutral genesis population.
 *
 * Every agent starts with the same objective substrate, resources, empty
 * learning priors and no published capability. Randomness belongs to the
 * policy stream (`agent/<id>`), not to the initial state.
 */
export function createGenesisAgents(config: GenesisConfig): LabAgentState[] {
  return Array.from({ length: config.agents }, (_, index) => ({
    id: `N${String(index + 1).padStart(4, "0")}`,
    active: true,
    generation: 0,
    lineage: [],
    resources: { ...config.initialResources },
    inbox: [],
    memory: {},
    learning: {
      attempts: {},
      successes: {},
      utilityPpm: {},
    },
    actionCounts: {},
    taskCounts: {},
    violations: 0,
    createdTick: 0,
  }));
}

export function assertRoleNeutralGenesis(agents: LabAgentState[]): void {
  if (agents.length === 0) throw new Error("Genesis population must contain at least one agent");
  const comparable = (agent: LabAgentState) => JSON.stringify({
    active: agent.active,
    generation: agent.generation,
    lineage: agent.lineage,
    resources: agent.resources,
    inbox: agent.inbox,
    memory: agent.memory,
    learning: agent.learning,
    actionCounts: agent.actionCounts,
    taskCounts: agent.taskCounts,
    violations: agent.violations,
    createdTick: agent.createdTick,
  });
  const baseline = comparable(agents[0]!);
  for (const agent of agents.slice(1)) {
    if (comparable(agent) !== baseline) {
      throw new Error(`Genesis agent ${agent.id} has a privileged initial state`);
    }
  }
}
