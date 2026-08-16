import type { NetworkPolicy, NetworkPolicyPatch } from "./types.js";
import { deepClone } from "./utils.js";

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  discovery: "active",
  acceptInbound: true,
  maxLinks: 8,
  minCompatibility: 0.35,
  maxCandidatesPerRound: 3,
  maxCommunicationCost: 8,
  minReliability: 0.5,
  preferredTurnModes: ["strict_alternation", "event_turn", "lease_turn"],
  preferredPayloadModes: ["delta", "event_only", "structured", "full_state"],
  preferredActivationModes: ["adaptive", "event", "hybrid", "heartbeat"],
  allowProtocolMutation: true,
  advertisementTtlMs: 60_000,
  proposalTtlMs: 15_000,
  maxNegotiationRounds: 6,
  probation: {
    requiredInteractions: 2,
    minStrength: 0.35,
    timeoutMs: 120_000
  },
  maxIdleMs: 300_000,
  retireBelowStrength: 0.002,
  reviewEveryRevisions: 6,
  rejectionCooldownMs: 30_000
};

export function mergeNetworkPolicy(patch: NetworkPolicyPatch = {}): NetworkPolicy {
  return {
    ...deepClone(DEFAULT_NETWORK_POLICY),
    ...deepClone(patch),
    preferredTurnModes: [...(patch.preferredTurnModes ?? DEFAULT_NETWORK_POLICY.preferredTurnModes)],
    preferredPayloadModes: [...(patch.preferredPayloadModes ?? DEFAULT_NETWORK_POLICY.preferredPayloadModes)],
    preferredActivationModes: [...(patch.preferredActivationModes ?? DEFAULT_NETWORK_POLICY.preferredActivationModes)],
    probation: {
      requiredInteractions: patch.probation?.requiredInteractions ?? DEFAULT_NETWORK_POLICY.probation.requiredInteractions,
      minStrength: patch.probation?.minStrength ?? DEFAULT_NETWORK_POLICY.probation.minStrength,
      timeoutMs: patch.probation?.timeoutMs ?? DEFAULT_NETWORK_POLICY.probation.timeoutMs
    }
  };
}
