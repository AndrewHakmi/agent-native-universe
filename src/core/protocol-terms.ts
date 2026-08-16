import type { DiscoveryAdvertisement, ProtocolPatch, ProtocolTerms } from "./types.js";
import { deepEqual, intersect, unique } from "./utils.js";

export const DEFAULT_PROTOCOL_TERMS: ProtocolTerms = {
  mode: "strict_alternation",
  fieldOwnership: {
    left: "left",
    right: "right",
    agreement: "runtime",
    contradictions: "either",
    resolutions: "either"
  },
  payloadMode: "delta",
  activationMode: "adaptive",
  minActivationIntervalMs: 0,
  heartbeatMs: 30_000,
  triggers: [],
  minInformationGain: 0,
  maxCommunicationCost: 8,
  decayRate: 0.000001,
  maxIdleMs: 300_000,
  retireBelowStrength: 0.002,
  reviewEveryRevisions: 6,
  probation: {
    requiredInteractions: 2,
    minStrength: 0.35,
    timeoutMs: 120_000
  }
};

export function negotiateInitialTerms(left: DiscoveryAdvertisement, right: DiscoveryAdvertisement, triggers: string[]): ProtocolTerms | null {
  const mode = firstCommon(left.policy.preferredTurnModes, right.policy.preferredTurnModes);
  const payloadMode = firstCommon(left.policy.preferredPayloadModes, right.policy.preferredPayloadModes);
  const activationMode = firstCommon(left.policy.preferredActivationModes, right.policy.preferredActivationModes);
  if (!mode || !payloadMode || !activationMode) return null;

  return {
    ...DEFAULT_PROTOCOL_TERMS,
    mode,
    payloadMode,
    activationMode,
    triggers: unique(triggers),
    maxCommunicationCost: Math.min(left.policy.maxCommunicationCost, right.policy.maxCommunicationCost),
    maxIdleMs: Math.min(left.policy.maxIdleMs, right.policy.maxIdleMs),
    retireBelowStrength: Math.max(left.policy.retireBelowStrength, right.policy.retireBelowStrength),
    reviewEveryRevisions: Math.min(left.policy.reviewEveryRevisions, right.policy.reviewEveryRevisions),
    probation: {
      requiredInteractions: Math.max(left.policy.probation.requiredInteractions, right.policy.probation.requiredInteractions),
      minStrength: Math.max(left.policy.probation.minStrength, right.policy.probation.minStrength),
      timeoutMs: Math.min(left.policy.probation.timeoutMs, right.policy.probation.timeoutMs)
    }
  };
}

export function termsSupportedBy(terms: ProtocolTerms, advertisement: DiscoveryAdvertisement): boolean {
  return advertisement.policy.preferredTurnModes.includes(terms.mode)
    && advertisement.policy.preferredPayloadModes.includes(terms.payloadMode)
    && advertisement.policy.preferredActivationModes.includes(terms.activationMode)
    && terms.maxCommunicationCost <= advertisement.policy.maxCommunicationCost
    && terms.probation.minStrength >= advertisement.policy.probation.minStrength
    && terms.probation.requiredInteractions >= advertisement.policy.probation.requiredInteractions
    && terms.retireBelowStrength >= advertisement.policy.retireBelowStrength;
}

export function stricterTerms(current: ProtocolTerms, self: DiscoveryAdvertisement, peer: DiscoveryAdvertisement): ProtocolTerms | null {
  const mode = bothSupport(current.mode, self.policy.preferredTurnModes, peer.policy.preferredTurnModes)
    ? current.mode
    : firstCommon(self.policy.preferredTurnModes, peer.policy.preferredTurnModes);
  const payloadMode = bothSupport(current.payloadMode, self.policy.preferredPayloadModes, peer.policy.preferredPayloadModes)
    ? current.payloadMode
    : firstCommon(self.policy.preferredPayloadModes, peer.policy.preferredPayloadModes);
  const activationMode = bothSupport(current.activationMode, self.policy.preferredActivationModes, peer.policy.preferredActivationModes)
    ? current.activationMode
    : firstCommon(self.policy.preferredActivationModes, peer.policy.preferredActivationModes);
  if (!mode || !payloadMode || !activationMode) return null;

  return {
    ...current,
    mode,
    payloadMode,
    activationMode,
    maxCommunicationCost: Math.min(current.maxCommunicationCost, self.policy.maxCommunicationCost, peer.policy.maxCommunicationCost),
    maxIdleMs: Math.min(current.maxIdleMs, self.policy.maxIdleMs, peer.policy.maxIdleMs),
    retireBelowStrength: Math.max(current.retireBelowStrength, self.policy.retireBelowStrength, peer.policy.retireBelowStrength),
    reviewEveryRevisions: Math.min(current.reviewEveryRevisions, self.policy.reviewEveryRevisions, peer.policy.reviewEveryRevisions),
    probation: {
      requiredInteractions: Math.max(current.probation.requiredInteractions, self.policy.probation.requiredInteractions, peer.policy.probation.requiredInteractions),
      minStrength: Math.max(current.probation.minStrength, self.policy.probation.minStrength, peer.policy.probation.minStrength),
      timeoutMs: Math.min(current.probation.timeoutMs, self.policy.probation.timeoutMs, peer.policy.probation.timeoutMs)
    }
  };
}

export function commonTopics(left: DiscoveryAdvertisement, right: DiscoveryAdvertisement): string[] {
  return unique([...intersect(left.accepts, right.produces), ...intersect(right.accepts, left.produces)]);
}

export function protocolPatchBetween(current: ProtocolTerms, next: ProtocolTerms): ProtocolPatch {
  const patch: ProtocolPatch = {};
  if (current.mode !== next.mode) patch.mode = next.mode;
  if (!deepEqual(current.fieldOwnership, next.fieldOwnership)) patch.fieldOwnership = { ...next.fieldOwnership };
  if (current.payloadMode !== next.payloadMode) patch.payloadMode = next.payloadMode;
  if (current.activationMode !== next.activationMode) patch.activationMode = next.activationMode;
  if (current.minActivationIntervalMs !== next.minActivationIntervalMs) patch.minActivationIntervalMs = next.minActivationIntervalMs;
  if (current.heartbeatMs !== next.heartbeatMs) patch.heartbeatMs = next.heartbeatMs;
  if (!deepEqual(current.triggers, next.triggers)) patch.triggers = [...next.triggers];
  if (current.minInformationGain !== next.minInformationGain) patch.minInformationGain = next.minInformationGain;
  if (current.maxCommunicationCost !== next.maxCommunicationCost) patch.maxCommunicationCost = next.maxCommunicationCost;
  if (current.decayRate !== next.decayRate) patch.decayRate = next.decayRate;
  if (current.maxIdleMs !== next.maxIdleMs) patch.maxIdleMs = next.maxIdleMs;
  if (current.retireBelowStrength !== next.retireBelowStrength) patch.retireBelowStrength = next.retireBelowStrength;
  if (current.reviewEveryRevisions !== next.reviewEveryRevisions) patch.reviewEveryRevisions = next.reviewEveryRevisions;
  if (!deepEqual(current.probation, next.probation)) patch.probation = { ...next.probation };
  return patch;
}

export function isEmptyProtocolPatch(patch: ProtocolPatch): boolean {
  return Object.keys(patch).length === 0;
}

function bothSupport<T extends string>(value: T, left: T[], right: T[]): boolean {
  return left.includes(value) && right.includes(value);
}

function firstCommon<T extends string>(preferred: T[], supported: T[]): T | undefined {
  const set = new Set(supported);
  return preferred.find(value => set.has(value));
}
