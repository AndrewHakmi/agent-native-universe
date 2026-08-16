export type AgentId = `na:${string}`;
export type LinkId = `lp:${string}`;
export type NegotiationId = `ng:${string}`;
export type RevisionId = number;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RiskClass = "none" | "low" | "medium" | "high" | "critical";
export type KnowledgeState = "known" | "probable" | "unknown" | "contradictory" | "stale" | "unverifiable";
export type AgentLifecycle = "created" | "initializing" | "active" | "waiting" | "negotiating" | "executing" | "verifying" | "dormant" | "degraded" | "quarantined" | "retired";
export type LinkLifecycle = "candidate" | "negotiating" | "probation" | "active" | "strengthening" | "weakening" | "dormant" | "conflicted" | "quarantined" | "renegotiating" | "retired";
export type TurnMode = "strict_alternation" | "conditional_turn" | "event_turn" | "lease_turn" | "priority_turn" | "consensus_turn";
export type FieldOwnership = "left" | "right" | "either" | "shared_consensus" | "runtime";
export type DiscoveryMode = "disabled" | "passive" | "active";
export type PayloadMode = "full_state" | "structured" | "delta" | "event_only";
export type ActivationMode = "adaptive" | "event" | "heartbeat" | "hybrid";
export type NegotiationAction = "accept" | "counter" | "reject" | "defer";
export type NegotiationStatus = "proposed" | "countered" | "accepted" | "rejected" | "deferred" | "expired";

export interface ObjectiveVector {
  primary: string;
  secondary: string[];
  antiGoals: string[];
  weights: Record<string, number>;
}

export interface Capability {
  id: string;
  accepts: string[];
  produces: string[];
  riskClass: RiskClass;
  estimatedCost?: { compute?: number; latencyMs?: number; money?: number };
}

export interface ConnectionNeed {
  id: string;
  accepts: string[];
  priority: number;
  recurring: boolean;
  maxCommunicationCost: number;
  minReliability: number;
}

export interface ProbationPolicy {
  requiredInteractions: number;
  minStrength: number;
  timeoutMs: number;
}

export interface NetworkPolicy {
  discovery: DiscoveryMode;
  acceptInbound: boolean;
  maxLinks: number;
  minCompatibility: number;
  maxCandidatesPerRound: number;
  maxCommunicationCost: number;
  minReliability: number;
  preferredTurnModes: TurnMode[];
  preferredPayloadModes: PayloadMode[];
  preferredActivationModes: ActivationMode[];
  allowProtocolMutation: boolean;
  advertisementTtlMs: number;
  proposalTtlMs: number;
  maxNegotiationRounds: number;
  probation: ProbationPolicy;
  maxIdleMs: number;
  retireBelowStrength: number;
  reviewEveryRevisions: number;
  rejectionCooldownMs: number;
}

export interface NetworkPolicyPatch extends Omit<Partial<NetworkPolicy>, "probation"> {
  probation?: Partial<ProbationPolicy>;
}

export interface DiscoveryAdvertisement {
  agentId: AgentId;
  generation: number;
  lifecycle: AgentLifecycle;
  primaryObjective: string;
  secondaryObjectives: string[];
  capabilityIds: string[];
  accepts: string[];
  produces: string[];
  needs: ConnectionNeed[];
  currentLinks: number;
  policy: NetworkPolicy;
  issuedAt: number;
  expiresAt: number;
}

export interface DiscoveryMatch {
  seeker: AgentId;
  peer: AgentId;
  score: number;
  forwardMatches: string[];
  reverseMatches: string[];
  objectiveAffinity: number;
  reciprocity: number;
  estimatedCommunicationCost: number;
  reasons: string[];
}

export interface ProtocolTerms {
  mode: TurnMode;
  fieldOwnership: Record<string, FieldOwnership>;
  payloadMode: PayloadMode;
  activationMode: ActivationMode;
  minActivationIntervalMs: number;
  heartbeatMs: number;
  triggers: string[];
  minInformationGain: number;
  maxCommunicationCost: number;
  decayRate: number;
  maxIdleMs: number;
  retireBelowStrength: number;
  reviewEveryRevisions: number;
  probation: ProbationPolicy;
}

export interface ProtocolPatch {
  mode?: TurnMode;
  fieldOwnership?: Record<string, FieldOwnership>;
  payloadMode?: PayloadMode;
  activationMode?: ActivationMode;
  minActivationIntervalMs?: number;
  heartbeatMs?: number;
  triggers?: string[];
  minInformationGain?: number;
  maxCommunicationCost?: number;
  decayRate?: number;
  maxIdleMs?: number;
  retireBelowStrength?: number;
  reviewEveryRevisions?: number;
  probation?: Partial<ProbationPolicy>;
}

export interface ConnectionOffer {
  id: NegotiationId;
  purpose: "formation" | "renegotiation";
  linkId?: LinkId;
  round: number;
  proposer: AgentId;
  recipient: AgentId;
  proposerAdvertisement: DiscoveryAdvertisement;
  recipientAdvertisement: DiscoveryAdvertisement;
  match: DiscoveryMatch;
  terms: ProtocolTerms;
  createdAt: number;
  expiresAt: number;
}

export interface NegotiationDecision {
  action: NegotiationAction;
  reason: string;
  counterTerms?: ProtocolTerms;
}

export interface NegotiationRecord {
  round: number;
  actor: AgentId;
  action: "propose" | NegotiationAction;
  terms: ProtocolTerms;
  reason: string;
  at: number;
}

export interface NegotiationSnapshot {
  id: NegotiationId;
  purpose: "formation" | "renegotiation";
  left: AgentId;
  right: AgentId;
  status: NegotiationStatus;
  currentOffer: ConnectionOffer;
  transcript: NegotiationRecord[];
  agreedTerms?: ProtocolTerms;
  rejectionReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Belief {
  proposition: string;
  value: JsonValue;
  state: KnowledgeState;
  confidence: number;
  source?: string[];
  observedAt: number;
  expiresAt?: number;
}

export interface Budget {
  compute: number;
  tokens: number;
  money: number;
  latencyMs: number;
  externalActions: number;
}

export interface Commitment {
  id: string;
  debtor: AgentId;
  creditor: AgentId;
  deliverable: string;
  condition?: string;
  dueRevision?: number;
  status: "active" | "fulfilled" | "violated" | "cancelled";
}

export interface Invariant<T = unknown> {
  id: string;
  description: string;
  check(value: T): boolean;
}

export interface LinkMetrics {
  activations: number;
  usefulUpdates: number;
  turnPasses: number;
  protocolMutations: number;
  successfulSynchronizations: number;
  informationGain: number;
  utility: number;
  reliability: number;
  communicationCost: number;
  errorRate: number;
  synchronizationQuality: number;
  lastActivatedAt?: number;
}

export interface Revision {
  id: RevisionId;
  author: AgentId | "runtime";
  parent: RevisionId | null;
  timestamp: number;
  delta: JsonObject;
  evidence: string[];
  kind: "state" | "protocol" | "lifecycle" | "recovery" | "turn" | "consensus";
}

export type TopologyEventType =
  | "agent_created"
  | "agent_retired"
  | "advertisement_published"
  | "candidate_selected"
  | "proposal_emitted"
  | "negotiation_countered"
  | "negotiation_accepted"
  | "negotiation_rejected"
  | "negotiation_deferred"
  | "link_created"
  | "link_probation"
  | "link_promoted"
  | "link_strengthened"
  | "link_weakened"
  | "link_dormant"
  | "link_reactivated"
  | "link_retired"
  | "boundary_synchronized"
  | "boundary_unchanged"
  | "boundary_rejected"
  | "turn_passed"
  | "protocol_proposed"
  | "protocol_reviewed"
  | "protocol_adapted"
  | "protocol_rejected"
  | "runtime_error";

export interface TopologyEvent {
  seq: number;
  at: number;
  type: TopologyEventType;
  actor?: AgentId | "runtime";
  agentId?: AgentId;
  peerId?: AgentId;
  linkId?: LinkId;
  negotiationId?: NegotiationId;
  detail: JsonObject;
}

export interface EvolutionOptions {
  /** Number of local evolution rounds to execute. */
  rounds?: number;
  /** Logical timestamp for round zero. */
  now?: number;
  /** Logical milliseconds between rounds. */
  stepMs?: number;
  /** Allow agents to publish advertisements and discover peers. */
  discovery?: boolean;
  /** Allow active links to exchange local boundary projections. */
  synchronization?: boolean;
  /** Allow the current turn owner to propose protocol adaptation. */
  protocolAdaptation?: boolean;
  /** Apply strength decay and lifecycle transitions. */
  lifecycleReview?: boolean;
  /** Per-agent cap on new accepted links in one round. */
  maxNewLinksPerAgentPerRound?: number;
  /** Maximum alternating link turns advanced in each global round. */
  maxLinkTurnsPerRound?: number;
}

export interface EvolutionError {
  scope: "agent" | "negotiation" | "link" | "runtime";
  entityId: string;
  message: string;
}

export interface EvolutionReport {
  rounds: number;
  advertisements: number;
  candidates: number;
  negotiations: number;
  counterOffers: number;
  acceptedNegotiations: number;
  rejectedNegotiations: NegotiationId[];
  deferredNegotiations: NegotiationId[];
  linksCreated: LinkId[];
  linksPromoted: LinkId[];
  linksDormant: LinkId[];
  linksReactivated: LinkId[];
  linksRetired: LinkId[];
  protocolsAdapted: LinkId[];
  synchronizedLinks: LinkId[];
  unchangedBoundaries: number;
  errors: EvolutionError[];
  events: TopologyEvent[];
}
