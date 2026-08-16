import { ConflictDetected, InvariantViolation, ProtocolViolation } from "./errors.js";
import { DEFAULT_PROTOCOL_TERMS } from "./protocol-terms.js";
import type {
  AgentId,
  FieldOwnership,
  Invariant,
  JsonObject,
  JsonValue,
  LinkId,
  LinkLifecycle,
  LinkMetrics,
  ProtocolPatch,
  ProtocolTerms,
  Revision,
  TurnMode
} from "./types.js";
import { applyProtocolPatch, clamp01, deepClone, linkId, mergeJson } from "./utils.js";

export interface LinkProtocolSpec {
  id?: LinkId;
  left: AgentId;
  right: AgentId;
  state?: JsonObject;
  terms?: ProtocolTerms;
  fieldOwnership?: Record<string, FieldOwnership>;
  mode?: TurnMode;
  turnOwner?: "left" | "right";
  lifecycle?: LinkLifecycle;
  invariants?: Invariant<LinkSnapshot>[];
  strength?: number;
  decayRate?: number;
  now?: number;
}

export interface LinkSnapshot {
  id: LinkId;
  left: AgentId;
  right: AgentId;
  state: JsonObject;
  terms: ProtocolTerms;
  fieldOwnership: Record<string, FieldOwnership>;
  mode: TurnMode;
  turnOwner: "left" | "right";
  lifecycle: LinkLifecycle;
  revisions: Revision[];
  metrics: LinkMetrics;
  strength: number;
  decayRate: number;
  createdAt: number;
  updatedAt: number;
  lastDecayAt: number;
  lastProtocolReviewRevision: number;
  probationStartedAt?: number;
}

export interface MutationProposal {
  author: AgentId;
  delta: JsonObject;
  evidence?: string[];
  informationGain?: number;
  utility?: number;
  communicationCost?: number;
  synchronization?: boolean;
}

export class LinkProtocol {
  #s: LinkSnapshot;
  #invariants: Invariant<LinkSnapshot>[];

  constructor(spec: LinkProtocolSpec) {
    const now = spec.now ?? Date.now();
    const baseTerms = deepClone(spec.terms ?? DEFAULT_PROTOCOL_TERMS);
    const terms: ProtocolTerms = {
      ...baseTerms,
      mode: spec.mode ?? baseTerms.mode,
      fieldOwnership: { ...baseTerms.fieldOwnership, ...(spec.fieldOwnership ?? {}) },
      decayRate: spec.decayRate ?? baseTerms.decayRate
    };
    const lifecycle = spec.lifecycle ?? "candidate";

    this.#s = {
      id: spec.id ?? linkId(),
      left: spec.left,
      right: spec.right,
      state: deepClone(spec.state ?? {}),
      terms,
      fieldOwnership: { ...terms.fieldOwnership },
      mode: terms.mode,
      turnOwner: spec.turnOwner ?? "left",
      lifecycle,
      revisions: [],
      metrics: {
        activations: 0,
        usefulUpdates: 0,
        turnPasses: 0,
        protocolMutations: 0,
        successfulSynchronizations: 0,
        informationGain: 0,
        utility: 0,
        reliability: 1,
        communicationCost: 0,
        errorRate: 0,
        synchronizationQuality: 1
      },
      strength: spec.strength ?? 0.1,
      decayRate: terms.decayRate,
      createdAt: now,
      updatedAt: now,
      lastDecayAt: now,
      lastProtocolReviewRevision: 0,
      ...(lifecycle === "probation" ? { probationStartedAt: now } : {})
    };
    this.#invariants = [...(spec.invariants ?? [])];
    this.#validate(this.#s);
  }

  get id(): LinkId { return this.#s.id; }
  snapshot(): LinkSnapshot { return deepClone(this.#s); }
  currentTurnAgent(): AgentId { return this.#s.turnOwner === "left" ? this.#s.left : this.#s.right; }

  beginNegotiation(now = Date.now()): void {
    this.#runtimeTransition("negotiating", "pairwise protocol negotiation started", now);
  }

  beginRenegotiation(now = Date.now()): void {
    this.#runtimeTransition("renegotiating", "adaptive protocol renegotiation started", now);
  }

  resumeAfterRenegotiation(previous: LinkLifecycle, now = Date.now()): void {
    if (this.#s.lifecycle !== "renegotiating") return;
    const resumable = previous === "active"
      || previous === "strengthening"
      || previous === "weakening"
      || previous === "conflicted";
    this.#runtimeTransition(resumable ? previous : "active", "adaptive protocol renegotiation completed", now);
  }

  enterProbation(now = Date.now()): void {
    this.#s.probationStartedAt = now;
    this.#runtimeTransition("probation", "negotiated link entered probation", now);
  }

  activate(now = Date.now()): void {
    this.#runtimeTransition("active", "link activated", now);
  }

  sleep(now = Date.now()): void {
    this.#runtimeTransition("dormant", "link became dormant", now);
  }

  retire(now = Date.now()): void {
    this.#runtimeTransition("retired", "link retired", now);
  }

  quarantine(now = Date.now()): void {
    this.#runtimeTransition("quarantined", "link quarantined", now);
  }

  mutate(proposal: MutationProposal, now = Date.now()): Revision {
    this.#assertWritable();
    this.#assertParticipant(proposal.author);
    this.#assertTurn(proposal.author);
    this.#assertFieldOwnership(proposal.author, proposal.delta);

    const informationGain = proposal.informationGain ?? 0;
    const communicationCost = proposal.communicationCost ?? 0;
    if (!Number.isFinite(informationGain) || informationGain < this.#s.terms.minInformationGain) {
      throw new ProtocolViolation(`information gain ${informationGain} below protocol threshold ${this.#s.terms.minInformationGain}`);
    }
    if (!Number.isFinite(communicationCost) || communicationCost < 0 || communicationCost > this.#s.terms.maxCommunicationCost) {
      throw new ProtocolViolation(`communication cost ${communicationCost} exceeds protocol maximum ${this.#s.terms.maxCommunicationCost}`);
    }

    const nextState = mergeJson(this.#s.state, proposal.delta);
    const revision: Revision = {
      id: this.#s.revisions.length + 1,
      author: proposal.author,
      parent: this.#s.revisions.at(-1)?.id ?? null,
      timestamp: now,
      delta: deepClone(proposal.delta),
      evidence: [...(proposal.evidence ?? [])],
      kind: "state"
    };
    const useful = Object.keys(proposal.delta).length > 0 ? 1 : 0;
    const metrics: LinkMetrics = {
      ...this.#s.metrics,
      activations: this.#s.metrics.activations + 1,
      usefulUpdates: this.#s.metrics.usefulUpdates + useful,
      successfulSynchronizations: this.#s.metrics.successfulSynchronizations + (proposal.synchronization ? 1 : 0),
      informationGain: this.#s.metrics.informationGain + informationGain,
      utility: this.#s.metrics.utility + (proposal.utility ?? 0),
      communicationCost: this.#s.metrics.communicationCost + communicationCost,
      lastActivatedAt: now
    };
    const next: LinkSnapshot = {
      ...this.#s,
      state: nextState,
      turnOwner: this.#nextTurn(proposal.author),
      revisions: [...this.#s.revisions, revision],
      metrics,
      updatedAt: now,
      strength: reinforcedStrength(this.#s.strength, metrics, true)
    };
    this.#validate(next);
    this.#s = next;
    return revision;
  }

  passTurn(author: AgentId, reason = "no boundary delta", now = Date.now()): Revision {
    this.#assertWritable();
    this.#assertParticipant(author);
    this.#assertTurn(author);

    const revision: Revision = {
      id: this.#s.revisions.length + 1,
      author,
      parent: this.#s.revisions.at(-1)?.id ?? null,
      timestamp: now,
      delta: {},
      evidence: [reason],
      kind: "turn"
    };
    const metrics: LinkMetrics = {
      ...this.#s.metrics,
      activations: this.#s.metrics.activations + 1,
      turnPasses: this.#s.metrics.turnPasses + 1,
      lastActivatedAt: now
    };
    const next: LinkSnapshot = {
      ...this.#s,
      turnOwner: this.#nextTurn(author),
      revisions: [...this.#s.revisions, revision],
      metrics,
      updatedAt: now,
      strength: reinforcedStrength(this.#s.strength, metrics, false)
    };
    this.#validate(next);
    this.#s = next;
    return revision;
  }

  consensusMutate(leftSigner: AgentId, rightSigner: AgentId, delta: JsonObject, evidence: string[] = [], now = Date.now()): Revision {
    this.#assertWritable();
    if (leftSigner !== this.#s.left || rightSigner !== this.#s.right) {
      throw new ProtocolViolation("consensus mutation requires both participants in canonical order");
    }
    for (const field of Object.keys(delta)) {
      const ownership = this.#s.fieldOwnership[field] ?? "either";
      if (ownership !== "shared_consensus" && ownership !== "either") {
        throw new ProtocolViolation(`${field} is not consensus writable`);
      }
    }

    const revision: Revision = {
      id: this.#s.revisions.length + 1,
      author: "runtime",
      parent: this.#s.revisions.at(-1)?.id ?? null,
      timestamp: now,
      delta: deepClone(delta),
      evidence: [leftSigner, rightSigner, ...evidence],
      kind: "consensus"
    };
    const next: LinkSnapshot = {
      ...this.#s,
      state: mergeJson(this.#s.state, delta),
      revisions: [...this.#s.revisions, revision],
      updatedAt: now
    };
    this.#validate(next);
    this.#s = next;
    return revision;
  }

  mutateProtocol(author: AgentId, patch: ProtocolPatch, evidence: string[] = [], now = Date.now()): Revision {
    this.#assertWritable();
    this.#assertParticipant(author);
    this.#assertTurn(author);
    if (Object.keys(patch).length === 0) throw new ProtocolViolation("protocol mutation patch cannot be empty");

    const terms = applyProtocolPatch(this.#s.terms, patch);
    const revision: Revision = {
      id: this.#s.revisions.length + 1,
      author,
      parent: this.#s.revisions.at(-1)?.id ?? null,
      timestamp: now,
      delta: patch as unknown as JsonObject,
      evidence,
      kind: "protocol"
    };
    const metrics: LinkMetrics = {
      ...this.#s.metrics,
      activations: this.#s.metrics.activations + 1,
      protocolMutations: this.#s.metrics.protocolMutations + 1,
      lastActivatedAt: now
    };
    const next: LinkSnapshot = {
      ...this.#s,
      terms,
      fieldOwnership: { ...terms.fieldOwnership },
      mode: terms.mode,
      decayRate: terms.decayRate,
      revisions: [...this.#s.revisions, revision],
      turnOwner: this.#oppositeSide(this.sideOf(author)),
      metrics,
      updatedAt: now,
      lastProtocolReviewRevision: revision.id,
      strength: reinforcedStrength(this.#s.strength, metrics, true)
    };
    this.#validate(next);
    this.#s = next;
    return revision;
  }

  shouldReviewProtocol(): boolean {
    return this.#s.revisions.length - this.#s.lastProtocolReviewRevision >= this.#s.terms.reviewEveryRevisions;
  }

  recommendProtocolPatch(): ProtocolPatch | null {
    if (!this.shouldReviewProtocol()) return null;
    const metrics = this.#s.metrics;
    const useful = Math.max(1, metrics.usefulUpdates);
    const costPerUsefulUpdate = metrics.communicationCost / useful;
    const informationPerActivation = metrics.informationGain / Math.max(1, metrics.activations);

    if (metrics.errorRate > 0.2 || metrics.synchronizationQuality < 0.7 || metrics.reliability < 0.7) {
      return {
        payloadMode: "full_state",
        activationMode: "heartbeat",
        heartbeatMs: Math.max(1_000, Math.min(this.#s.terms.heartbeatMs, 10_000)),
        minInformationGain: 0
      };
    }
    if (costPerUsefulUpdate > this.#s.terms.maxCommunicationCost * 0.75) {
      return {
        payloadMode: nextCompression(this.#s.terms.payloadMode),
        activationMode: "event",
        minInformationGain: Math.max(this.#s.terms.minInformationGain, 0.01)
      };
    }
    if (metrics.activations >= 4 && informationPerActivation < 0.05) {
      return {
        payloadMode: "event_only",
        activationMode: "event",
        minInformationGain: Math.min(0.5, this.#s.terms.minInformationGain + 0.05)
      };
    }
    if (this.#s.strength > 0.75 && metrics.errorRate < 0.05) {
      return {
        decayRate: Math.max(0, this.#s.terms.decayRate * 0.5),
        maxIdleMs: Math.round(this.#s.terms.maxIdleMs * 1.5)
      };
    }
    return null;
  }

  markProtocolReviewed(): void {
    this.#s.lastProtocolReviewRevision = this.#s.revisions.length;
  }

  recordFailure(): void {
    const metrics = this.#s.metrics;
    const failures = metrics.errorRate * Math.max(1, metrics.activations) + 1;
    const next: LinkMetrics = {
      ...metrics,
      errorRate: failures / Math.max(1, metrics.activations + 1),
      reliability: Math.max(0, metrics.reliability * 0.9),
      synchronizationQuality: Math.max(0, metrics.synchronizationQuality * 0.9)
    };
    this.#s.metrics = next;
    this.#s.strength = clamp01(Math.min(this.#s.strength, evidenceStrength(next)) * 0.9);
  }

  addContradiction(author: AgentId, proposition: string, left: unknown, right: unknown, now = Date.now()): Revision {
    const revision = this.mutate({
      author,
      delta: {
        contradictions: {
          [proposition]: {
            left: left as JsonValue,
            right: right as JsonValue,
            status: "unresolved"
          }
        }
      },
      evidence: ["contradiction-detected"]
    }, now);
    this.#runtimeTransition("conflicted", "contradiction preserved", now);
    return revision;
  }

  resolveContradiction(author: AgentId, proposition: string, resolution: unknown, evidence: string[], now = Date.now()): Revision {
    const revision = this.mutate({
      author,
      delta: { resolutions: { [proposition]: resolution as JsonValue } },
      evidence
    }, now);
    this.#runtimeTransition("active", "contradiction resolved", now);
    return revision;
  }

  decay(now = Date.now()): number {
    const deltaMs = Math.max(0, now - this.#s.lastDecayAt);
    if (deltaMs === 0) return this.#s.strength;
    this.#s.strength = clamp01(this.#s.strength * Math.exp(-this.#s.decayRate * deltaMs));
    this.#s.lastDecayAt = now;
    return this.#s.strength;
  }

  reviewLifecycle(now = Date.now()): LinkLifecycle {
    const previous = this.#s.lifecycle;
    const lastActivity = this.#s.metrics.lastActivatedAt ?? this.#s.createdAt;

    if (previous === "probation") {
      const startedAt = this.#s.probationStartedAt ?? this.#s.createdAt;
      const enoughInteractions = this.#s.metrics.successfulSynchronizations >= this.#s.terms.probation.requiredInteractions
        || this.#s.metrics.usefulUpdates >= this.#s.terms.probation.requiredInteractions;
      if (enoughInteractions && this.#s.strength >= this.#s.terms.probation.minStrength) {
        this.#runtimeTransition("active", "probation passed", now);
      } else if (now - startedAt > this.#s.terms.probation.timeoutMs) {
        this.#runtimeTransition("retired", "probation timed out", now);
      }
    } else if (previous === "active" || previous === "strengthening" || previous === "weakening") {
      if (this.#s.strength < this.#s.terms.retireBelowStrength) {
        this.#runtimeTransition("dormant", "strength below active threshold", now);
      } else if (this.#s.strength > 0.75) {
        this.#runtimeTransition("strengthening", "high-value relationship", now);
      } else if (this.#s.strength < 0.1) {
        this.#runtimeTransition("weakening", "relationship losing utility", now);
      } else if (previous !== "active") {
        this.#runtimeTransition("active", "relationship stabilized", now);
      }
    } else if (previous === "dormant" && now - lastActivity > this.#s.terms.maxIdleMs) {
      this.#runtimeTransition("retired", "dormant relationship exceeded max idle time", now);
    }
    return this.#s.lifecycle;
  }

  recalculateStrength(): number {
    this.#s.strength = evidenceStrength(this.#s.metrics);
    return this.#s.strength;
  }

  sideOf(agent: AgentId): "left" | "right" {
    if (agent === this.#s.left) return "left";
    if (agent === this.#s.right) return "right";
    throw new ProtocolViolation(`${agent} is not a participant of ${this.id}`);
  }

  other(agent: AgentId): AgentId {
    return this.sideOf(agent) === "left" ? this.#s.right : this.#s.left;
  }

  #assertWritable(): void {
    if (this.#s.lifecycle === "retired" || this.#s.lifecycle === "quarantined") {
      throw new ProtocolViolation(`link ${this.id} is ${this.#s.lifecycle}`);
    }
  }

  #assertParticipant(agent: AgentId): void {
    this.sideOf(agent);
  }

  #assertTurn(agent: AgentId): void {
    if (this.#s.mode === "consensus_turn") return;
    if (this.sideOf(agent) !== this.#s.turnOwner) throw new ProtocolViolation(`not ${agent}'s turn on ${this.id}`);
  }

  #assertFieldOwnership(author: AgentId, delta: JsonObject): void {
    const side = this.sideOf(author);
    for (const field of Object.keys(delta)) {
      const ownership = this.#s.fieldOwnership[field] ?? "either";
      if (ownership === "runtime") throw new ProtocolViolation(`${field} is runtime-owned`);
      if (ownership === "shared_consensus") throw new ConflictDetected(`${field} requires consensus mutation`);
      if (ownership !== "either" && ownership !== side) {
        throw new ProtocolViolation(`${side} cannot write ${field}; owner=${ownership}`);
      }
    }
  }

  #nextTurn(author: AgentId): "left" | "right" {
    if (this.#s.mode === "consensus_turn") return this.#s.turnOwner;
    return this.#oppositeSide(this.sideOf(author));
  }

  #oppositeSide(side: "left" | "right"): "left" | "right" {
    return side === "left" ? "right" : "left";
  }

  #runtimeTransition(lifecycle: LinkLifecycle, reason: string, now: number): void {
    if (this.#s.lifecycle === lifecycle) return;
    const revision: Revision = {
      id: this.#s.revisions.length + 1,
      author: "runtime",
      parent: this.#s.revisions.at(-1)?.id ?? null,
      timestamp: now,
      delta: { from: this.#s.lifecycle, to: lifecycle },
      evidence: [reason],
      kind: "lifecycle"
    };
    const next: LinkSnapshot = {
      ...this.#s,
      lifecycle,
      revisions: [...this.#s.revisions, revision],
      updatedAt: now,
      ...(lifecycle === "probation" && this.#s.probationStartedAt === undefined ? { probationStartedAt: now } : {})
    };
    this.#validate(next);
    this.#s = next;
  }

  #validate(value: LinkSnapshot): void {
    if (value.left === value.right) throw new InvariantViolation("link participants must be distinct");
    if (value.strength < 0 || value.strength > 1) throw new InvariantViolation("strength must be in [0,1]");
    if (value.decayRate < 0) throw new InvariantViolation("decayRate cannot be negative");
    if (value.terms.maxCommunicationCost < 0) throw new InvariantViolation("maxCommunicationCost cannot be negative");
    if (value.terms.minInformationGain < 0) throw new InvariantViolation("minInformationGain cannot be negative");
    if (value.terms.reviewEveryRevisions < 1) throw new InvariantViolation("reviewEveryRevisions must be at least 1");
    if (value.terms.probation.requiredInteractions < 1) throw new InvariantViolation("probation requiredInteractions must be at least 1");
    if (value.terms.probation.minStrength < 0 || value.terms.probation.minStrength > 1) {
      throw new InvariantViolation("probation minStrength must be in [0,1]");
    }
    for (const invariant of this.#invariants) {
      if (!invariant.check(value)) throw new InvariantViolation(`Link invariant failed: ${invariant.id}: ${invariant.description}`);
    }
  }
}

function evidenceStrength(metrics: LinkMetrics): number {
  const frequency = Math.log1p(metrics.activations);
  const usefulRatio = metrics.activations === 0 ? 0 : metrics.usefulUpdates / metrics.activations;
  const synchronizationRatio = metrics.activations === 0 ? 0 : metrics.successfulSynchronizations / metrics.activations;
  const raw = 0.08 * frequency
    + 0.18 * usefulRatio
    + 0.12 * synchronizationRatio
    + 0.18 * normalized(metrics.informationGain)
    + 0.14 * normalized(metrics.utility)
    + 0.14 * metrics.reliability
    + 0.14 * metrics.synchronizationQuality
    - 0.10 * normalized(metrics.communicationCost)
    - 0.16 * metrics.errorRate
    - 0.04 * normalized(metrics.turnPasses);
  return clamp01(raw);
}

function reinforcedStrength(previous: number, metrics: LinkMetrics, useful: boolean): number {
  const evidence = evidenceStrength(metrics);
  if (!useful) return clamp01(Math.min(previous, evidence + 0.05));
  return clamp01(Math.max(evidence, previous + (1 - previous) * 0.18));
}

function normalized(value: number): number {
  return value <= 0 ? 0 : value / (1 + value);
}

function nextCompression(mode: ProtocolTerms["payloadMode"]): ProtocolTerms["payloadMode"] {
  if (mode === "full_state") return "structured";
  if (mode === "structured") return "delta";
  return "event_only";
}
