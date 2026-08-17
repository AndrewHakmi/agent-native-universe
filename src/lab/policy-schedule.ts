import { compareCodeUnits } from "./canonical.js";
import { observeWorld } from "./environment.js";
import type { NeutralPolicyRandomSource } from "./neutral-policy.js";
import type {
  LabAgentState,
  Observation,
  WorldAction,
  WorldState,
} from "./types.js";

export interface LogicalPolicy {
  readonly id: string;
  decide(observation: Observation, agent: LabAgentState, rng: NeutralPolicyRandomSource): WorldAction[];
}

export interface PolicyDecision {
  actorId: string;
  localIndex: number;
  action: WorldAction;
}

export interface DeferredPolicyViolation {
  actorId: string;
  reason: string;
}

export interface PolicyDecisionBatch {
  observations: Observation[];
  decisions: PolicyDecision[];
  violations: DeferredPolicyViolation[];
}

/**
 * Derive one policy decision batch from a single immutable world snapshot.
 *
 * The live engine and authoritative replay share this function so agent order,
 * observation boundaries, policy failures, and local action indexes cannot
 * drift into two subtly different protocol implementations.
 */
export function decidePolicyTick(
  snapshot: WorldState,
  tick: number,
  policy: LogicalPolicy,
  policyRng: NeutralPolicyRandomSource,
): PolicyDecisionBatch {
  const agentIds = Object.values(snapshot.agents)
    .filter((agent) => agent.active)
    .map((agent) => agent.id)
    .sort(compareCodeUnits);
  const observations: Observation[] = [];
  const decisions: PolicyDecision[] = [];
  const violations: DeferredPolicyViolation[] = [];

  for (const agentId of agentIds) {
    const observation = observeWorld(snapshot, agentId, tick);
    observations.push(structuredClone(observation));
    try {
      const actions = policy.decide(
        deepFreeze(structuredClone(observation)),
        deepFreeze(structuredClone(snapshot.agents[agentId]!)),
        policyRng,
      );
      for (const [localIndex, action] of actions.entries()) {
        decisions.push({ actorId: agentId, localIndex, action: structuredClone(action) });
      }
    } catch (error) {
      violations.push({
        actorId: agentId,
        reason: `policy error: ${errorMessage(error)}`,
      });
    }
  }

  return { observations, decisions, violations };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
