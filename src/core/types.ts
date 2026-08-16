export type AgentId = `na:${string}`;
export type LinkId = `lp:${string}`;
export type RevisionId = number;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type KnowledgeState = "known" | "probable" | "unknown" | "contradictory" | "stale" | "unverifiable";
export type AgentLifecycle = "created" | "initializing" | "active" | "waiting" | "negotiating" | "executing" | "verifying" | "dormant" | "degraded" | "quarantined" | "retired";
export type LinkLifecycle = "candidate" | "negotiating" | "probation" | "active" | "strengthening" | "weakening" | "dormant" | "conflicted" | "quarantined" | "renegotiating" | "retired";
export type TurnMode = "strict_alternation" | "conditional_turn" | "event_turn" | "lease_turn" | "priority_turn" | "consensus_turn";
export type FieldOwnership = "left" | "right" | "either" | "shared_consensus" | "runtime";

export interface ObjectiveVector { primary: string; secondary: string[]; antiGoals: string[]; weights: Record<string, number>; }
export interface Capability { id: string; accepts: string[]; produces: string[]; riskClass: "none" | "low" | "medium" | "high" | "critical"; estimatedCost?: { compute?: number; latencyMs?: number; money?: number }; }
export interface Belief { proposition: string; value: JsonValue; state: KnowledgeState; confidence: number; source?: string[]; observedAt: number; expiresAt?: number; }
export interface Budget { compute: number; tokens: number; money: number; latencyMs: number; externalActions: number; }
export interface Commitment { id: string; debtor: AgentId; creditor: AgentId; deliverable: string; condition?: string; dueRevision?: number; status: "active" | "fulfilled" | "violated" | "cancelled"; }
export interface Invariant<T = unknown> { id: string; description: string; check(value: T): boolean; }
export interface LinkMetrics { activations: number; usefulUpdates: number; informationGain: number; utility: number; reliability: number; communicationCost: number; errorRate: number; synchronizationQuality: number; lastActivatedAt?: number; }
export interface Revision { id: RevisionId; author: AgentId | "runtime"; parent: RevisionId | null; timestamp: number; delta: JsonObject; evidence: string[]; kind: "state" | "protocol" | "lifecycle" | "recovery"; }
