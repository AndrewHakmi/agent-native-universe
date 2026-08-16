import { BudgetViolation, InvariantViolation, PermissionViolation } from "./errors.js";
import type { NanoAgentBehavior } from "./agent-behavior.js";
import { scoreAdvertisements } from "./discovery.js";
import { mergeNetworkPolicy } from "./network-policy.js";
import { stricterTerms, termsSupportedBy } from "./protocol-terms.js";
import type {
  AgentId,
  AgentLifecycle,
  Belief,
  Budget,
  Capability,
  Commitment,
  ConnectionNeed,
  ConnectionOffer,
  DiscoveryAdvertisement,
  DiscoveryMatch,
  Invariant,
  JsonObject,
  LinkId,
  NegotiationDecision,
  NetworkPolicy,
  NetworkPolicyPatch,
  ObjectiveVector,
  ProtocolPatch
} from "./types.js";
import { agentId, assertConfidence, clamp01, deepClone, deepEqual, mergeJson, unique } from "./utils.js";
import type { LinkSnapshot } from "./link-protocol.js";

export interface NanoAgentSpec {
  id?: AgentId;
  generation?: number;
  lineage?: AgentId[];
  objective: ObjectiveVector;
  capabilities?: Capability[];
  needs?: ConnectionNeed[];
  networkPolicy?: NetworkPolicyPatch;
  behavior?: NanoAgentBehavior;
  privateState?: JsonObject;
  exposedState?: JsonObject;
  durableState?: JsonObject;
  ephemeralState?: JsonObject;
  beliefs?: Belief[];
  permissions?: string[];
  budget?: Partial<Budget>;
  invariants?: Invariant<NanoAgentSnapshot>[];
  ttlMs?: number;
}

export interface NanoAgentSnapshot {
  id: AgentId;
  generation: number;
  lineage: AgentId[];
  objective: ObjectiveVector;
  lifecycle: AgentLifecycle;
  capabilities: Capability[];
  needs: ConnectionNeed[];
  networkPolicy: NetworkPolicy;
  privateState: JsonObject;
  exposedState: JsonObject;
  durableState: JsonObject;
  ephemeralState: JsonObject;
  beliefs: Belief[];
  commitments: Commitment[];
  permissions: string[];
  budget: Budget;
  links: LinkId[];
  createdAt: number;
  updatedAt: number;
  ttlMs?: number;
}

const DEFAULT_BUDGET: Budget = {
  compute: Infinity,
  tokens: Infinity,
  money: Infinity,
  latencyMs: Infinity,
  externalActions: Infinity
};

const NETWORK_LIFECYCLES = new Set<AgentLifecycle>([
  "active",
  "waiting",
  "negotiating",
  "executing",
  "verifying"
]);

export class NanoAgent {
  #s: NanoAgentSnapshot;
  #invariants: Invariant<NanoAgentSnapshot>[];
  #behavior: NanoAgentBehavior | undefined;

  constructor(spec: NanoAgentSpec) {
    const now = Date.now();
    this.#s = {
      id: spec.id ?? agentId(),
      generation: spec.generation ?? 0,
      lineage: [...(spec.lineage ?? [])],
      objective: deepClone(spec.objective),
      lifecycle: "created",
      capabilities: deepClone(spec.capabilities ?? []),
      needs: deepClone(spec.needs ?? []),
      networkPolicy: mergeNetworkPolicy(spec.networkPolicy),
      privateState: deepClone(spec.privateState ?? {}),
      exposedState: deepClone(spec.exposedState ?? {}),
      durableState: deepClone(spec.durableState ?? {}),
      ephemeralState: deepClone(spec.ephemeralState ?? {}),
      beliefs: deepClone(spec.beliefs ?? []),
      commitments: [],
      permissions: [...(spec.permissions ?? [])],
      budget: { ...DEFAULT_BUDGET, ...(spec.budget ?? {}) },
      links: [],
      createdAt: now,
      updatedAt: now,
      ...(spec.ttlMs === undefined ? {} : { ttlMs: spec.ttlMs })
    };
    this.#behavior = spec.behavior;
    this.#invariants = [...(spec.invariants ?? [])];
    this.#validate(this.#s);
  }

  get id(): AgentId { return this.#s.id; }
  get lifecycle(): AgentLifecycle { return this.#s.lifecycle; }
  snapshot(): NanoAgentSnapshot { return deepClone(this.#s); }

  isNetworkEligible(): boolean {
    return NETWORK_LIFECYCLES.has(this.#s.lifecycle) && this.#s.networkPolicy.discovery !== "disabled";
  }

  remainingLinkCapacity(): number {
    return Math.max(0, this.#s.networkPolicy.maxLinks - this.#s.links.length);
  }

  activate(): void { this.#transition("active"); }
  wait(): void { this.#transition("waiting"); }
  beginNegotiation(): void {
    if (NETWORK_LIFECYCLES.has(this.#s.lifecycle) && this.#s.lifecycle !== "negotiating") this.#transition("negotiating");
  }
  endNegotiation(): void {
    if (this.#s.lifecycle === "negotiating") this.#transition("active");
  }
  sleep(): void { this.#transition("dormant"); }
  retire(): void { this.#transition("retired"); }
  quarantine(): void { this.#transition("quarantined"); }

  expose(delta: JsonObject): void {
    this.#mutate({ exposedState: mergeJson(this.#s.exposedState, delta) });
  }

  remember(delta: JsonObject): void {
    this.#mutate({ durableState: mergeJson(this.#s.durableState, delta) });
  }

  think(delta: JsonObject): void {
    this.#mutate({ privateState: mergeJson(this.#s.privateState, delta) });
  }

  setEphemeral(delta: JsonObject): void {
    this.#mutate({ ephemeralState: mergeJson(this.#s.ephemeralState, delta) });
  }

  updateNetworkPolicy(patch: NetworkPolicyPatch): void {
    this.#mutate({
      networkPolicy: mergeNetworkPolicy({
        ...this.#s.networkPolicy,
        ...patch,
        probation: { ...this.#s.networkPolicy.probation, ...(patch.probation ?? {}) }
      })
    });
  }

  replaceNeeds(needs: ConnectionNeed[]): void {
    this.#mutate({ needs: deepClone(needs) });
  }

  addNeed(need: ConnectionNeed): void {
    const next = this.#s.needs.filter(existing => existing.id !== need.id);
    next.push(deepClone(need));
    this.#mutate({ needs: next });
  }

  removeNeed(id: string): void {
    this.#mutate({ needs: this.#s.needs.filter(need => need.id !== id) });
  }

  setBelief(belief: Belief): void {
    assertConfidence(belief.confidence);
    const beliefs = this.#s.beliefs.filter(existing => existing.proposition !== belief.proposition);
    beliefs.push(deepClone(belief));
    this.#mutate({ beliefs });
  }

  addLink(id: LinkId): void {
    if (!this.#s.links.includes(id)) this.#mutate({ links: [...this.#s.links, id] });
  }

  removeLink(id: LinkId): void {
    this.#mutate({ links: this.#s.links.filter(existing => existing !== id) });
  }

  addCommitment(commitment: Commitment): void {
    this.#mutate({ commitments: [...this.#s.commitments, deepClone(commitment)] });
  }

  requirePermission(permission: string): void {
    if (!this.#s.permissions.includes(permission)) throw new PermissionViolation(`${this.id} lacks ${permission}`);
  }

  consumeBudget(kind: keyof Budget, amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) throw new BudgetViolation("budget consumption must be a finite non-negative number");
    const current = this.#s.budget[kind];
    if (current < amount) throw new BudgetViolation(`${this.id} exhausted ${kind}`);
    this.#mutate({ budget: { ...this.#s.budget, [kind]: current - amount } });
  }

  advertisement(now = Date.now()): DiscoveryAdvertisement {
    const accepts = unique([
      ...this.#s.capabilities.flatMap(capability => capability.accepts),
      ...this.#s.needs.flatMap(need => need.accepts)
    ]);
    const produces = unique(this.#s.capabilities.flatMap(capability => capability.produces));
    const needs = this.#s.needs.length > 0
      ? deepClone(this.#s.needs)
      : accepts.length > 0
        ? [{
            id: "implicit:capability-inputs",
            accepts,
            priority: 0.5,
            recurring: true,
            maxCommunicationCost: this.#s.networkPolicy.maxCommunicationCost,
            minReliability: this.#s.networkPolicy.minReliability
          }]
        : [];

    return {
      agentId: this.id,
      generation: this.#s.generation,
      lifecycle: this.#s.lifecycle,
      primaryObjective: this.#s.objective.primary,
      secondaryObjectives: [...this.#s.objective.secondary],
      capabilityIds: this.#s.capabilities.map(capability => capability.id),
      accepts,
      produces,
      needs,
      currentLinks: this.#s.links.length,
      policy: deepClone(this.#s.networkPolicy),
      issuedAt: now,
      expiresAt: now + this.#s.networkPolicy.advertisementTtlMs
    };
  }

  async discover(peers: DiscoveryAdvertisement[], neighborIds: Set<AgentId>, now = Date.now()): Promise<DiscoveryMatch[]> {
    if (this.#s.networkPolicy.discovery !== "active" || !NETWORK_LIFECYCLES.has(this.#s.lifecycle)) return [];
    const capacity = this.remainingLinkCapacity();
    if (capacity === 0) return [];

    const selfAdvertisement = this.advertisement(now);
    const matches: DiscoveryMatch[] = [];
    for (const peer of peers) {
      if (peer.agentId === this.id || peer.expiresAt <= now || neighborIds.has(peer.agentId)) continue;
      if (!peer.policy.acceptInbound || peer.policy.discovery === "disabled") continue;
      if (peer.currentLinks >= peer.policy.maxLinks) continue;

      let match = scoreAdvertisements(selfAdvertisement, peer);
      if (this.#behavior?.adjustCandidateScore) {
        const adjusted = await this.#behavior.adjustCandidateScore({
          self: this.snapshot(),
          peer: deepClone(peer),
          match: deepClone(match)
        });
        match = { ...match, score: clamp01(adjusted) };
      }

      const threshold = Math.max(this.#s.networkPolicy.minCompatibility, peer.policy.minCompatibility);
      if (match.score >= threshold) matches.push(match);
    }

    return matches
      .sort((a, b) => b.score - a.score || a.peer.localeCompare(b.peer))
      .slice(0, Math.min(capacity, this.#s.networkPolicy.maxCandidatesPerRound));
  }

  async evaluateOffer(offer: ConnectionOffer, now = Date.now()): Promise<NegotiationDecision> {
    if (offer.recipient !== this.id) return { action: "reject", reason: "offer addressed to another agent" };
    if (offer.expiresAt <= now) return { action: "reject", reason: "offer expired" };
    if (!NETWORK_LIFECYCLES.has(this.#s.lifecycle)) return { action: "reject", reason: `lifecycle ${this.#s.lifecycle} cannot negotiate` };
    if (offer.purpose === "formation" && (!this.#s.networkPolicy.acceptInbound || this.#s.networkPolicy.discovery === "disabled")) {
      return { action: "reject", reason: "inbound discovery disabled" };
    }
    if (offer.purpose === "renegotiation" && !this.#s.networkPolicy.allowProtocolMutation) {
      return { action: "reject", reason: "protocol mutation disabled" };
    }
    if (offer.purpose === "formation" && this.#s.links.length >= this.#s.networkPolicy.maxLinks) return { action: "reject", reason: "link capacity exhausted" };
    if (offer.purpose === "formation" && offer.match.score < this.#s.networkPolicy.minCompatibility) return { action: "reject", reason: "compatibility below local threshold" };
    if (offer.match.estimatedCommunicationCost > this.#s.networkPolicy.maxCommunicationCost) return { action: "reject", reason: "estimated communication cost exceeds local budget" };

    if (this.#behavior?.evaluateOffer) {
      const custom = await this.#behavior.evaluateOffer({ self: this.snapshot(), offer: deepClone(offer) });
      if (custom) {
        if (custom.action === "accept" && !termsSupportedBy(offer.terms, this.advertisement(now))) {
          return { action: "reject", reason: "custom behavior accepted unsupported protocol terms" };
        }
        return custom;
      }
    }

    const localAdvertisement = this.advertisement(now);
    const negotiated = stricterTerms(offer.terms, localAdvertisement, offer.proposerAdvertisement);
    if (!negotiated) return { action: "reject", reason: "no compatible protocol mode" };
    if (!deepEqual(negotiated, offer.terms)) {
      return {
        action: "counter",
        reason: "countering with locally admissible stricter terms",
        counterTerms: negotiated
      };
    }
    return { action: "accept", reason: "capability fit and protocol terms accepted" };
  }

  async projectBoundary(peer: NanoAgentSnapshot, link: LinkSnapshot): Promise<JsonObject | null> {
    if (this.#behavior?.projectBoundaryState) {
      return this.#behavior.projectBoundaryState({
        self: this.snapshot(),
        peer: deepClone(peer),
        link: deepClone(link)
      });
    }
    return deepClone(this.#s.exposedState);
  }

  async suggestProtocolPatch(peer: NanoAgentSnapshot, link: LinkSnapshot): Promise<ProtocolPatch | null> {
    if (!this.#s.networkPolicy.allowProtocolMutation) return null;
    if (this.#behavior?.suggestProtocolPatch) {
      return this.#behavior.suggestProtocolPatch({
        self: this.snapshot(),
        peer: deepClone(peer),
        link: deepClone(link)
      });
    }
    return null;
  }

  /**
   * Records a peer projection without exposing or merging the peer's private
   * state. Boundary observations are ephemeral local context and can be
   * promoted to durable memory explicitly by the agent when useful.
   */
  observeBoundary(link: LinkId, source: AgentId, boundary: JsonObject, observedAt = Date.now()): void {
    this.#mutate({
      ephemeralState: mergeJson(this.#s.ephemeralState, {
        observedBoundaries: {
          [link]: {
            source,
            observedAt,
            boundary: deepClone(boundary)
          }
        }
      })
    });
  }

  clone(overrides: Partial<NanoAgentSpec> = {}): NanoAgent {
    const behavior = overrides.behavior ?? this.#behavior;
    const spec: NanoAgentSpec = {
      objective: overrides.objective ?? this.#s.objective,
      capabilities: overrides.capabilities ?? this.#s.capabilities,
      needs: overrides.needs ?? this.#s.needs,
      networkPolicy: overrides.networkPolicy ?? this.#s.networkPolicy,
      privateState: overrides.privateState ?? this.#s.privateState,
      exposedState: overrides.exposedState ?? this.#s.exposedState,
      durableState: overrides.durableState ?? this.#s.durableState,
      ephemeralState: overrides.ephemeralState ?? {},
      beliefs: overrides.beliefs ?? this.#s.beliefs,
      permissions: overrides.permissions ?? this.#s.permissions,
      budget: overrides.budget ?? this.#s.budget,
      generation: this.#s.generation + 1,
      lineage: [...this.#s.lineage, this.#s.id],
      ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs })
    };
    if (behavior !== undefined) spec.behavior = behavior;
    return new NanoAgent(spec);
  }

  split(objectives: ObjectiveVector[]): NanoAgent[] {
    if (objectives.length < 2) throw new Error("split requires at least two objectives");
    return objectives.map(objective => this.clone({ objective }));
  }

  static merge(a: NanoAgent, b: NanoAgent, objective: ObjectiveVector): NanoAgent {
    const left = a.snapshot();
    const right = b.snapshot();
    return new NanoAgent({
      objective,
      capabilities: uniqueById([...left.capabilities, ...right.capabilities]),
      needs: uniqueNeeds([...left.needs, ...right.needs]),
      networkPolicy: {
        ...left.networkPolicy,
        maxLinks: Math.max(left.networkPolicy.maxLinks, right.networkPolicy.maxLinks),
        minCompatibility: Math.min(left.networkPolicy.minCompatibility, right.networkPolicy.minCompatibility),
        maxCommunicationCost: Math.max(left.networkPolicy.maxCommunicationCost, right.networkPolicy.maxCommunicationCost)
      },
      exposedState: mergeJson(left.exposedState, right.exposedState),
      durableState: mergeJson(left.durableState, right.durableState),
      beliefs: dedupeBeliefs([...left.beliefs, ...right.beliefs]),
      permissions: [...new Set([...left.permissions, ...right.permissions])],
      budget: {
        compute: left.budget.compute + right.budget.compute,
        tokens: left.budget.tokens + right.budget.tokens,
        money: left.budget.money + right.budget.money,
        latencyMs: Math.max(left.budget.latencyMs, right.budget.latencyMs),
        externalActions: left.budget.externalActions + right.budget.externalActions
      },
      generation: Math.max(left.generation, right.generation) + 1,
      lineage: [...new Set([...left.lineage, left.id, ...right.lineage, right.id])]
    });
  }

  #transition(lifecycle: AgentLifecycle): void {
    this.#mutate({ lifecycle });
  }

  #mutate(patch: Partial<NanoAgentSnapshot>): void {
    const next = { ...this.#s, ...deepClone(patch), updatedAt: Date.now() };
    this.#validate(next);
    this.#s = next;
  }

  #validate(value: NanoAgentSnapshot): void {
    if (value.networkPolicy.maxLinks < 0) throw new InvariantViolation("maxLinks cannot be negative");
    if (value.networkPolicy.minCompatibility < 0 || value.networkPolicy.minCompatibility > 1) {
      throw new InvariantViolation("minCompatibility must be in [0,1]");
    }
    if (value.links.length > value.networkPolicy.maxLinks) {
      throw new InvariantViolation(`link count ${value.links.length} exceeds maxLinks ${value.networkPolicy.maxLinks}`);
    }
    for (const need of value.needs) {
      if (need.priority < 0 || need.priority > 1) throw new InvariantViolation(`need ${need.id} priority must be in [0,1]`);
      if (need.maxCommunicationCost < 0) throw new InvariantViolation(`need ${need.id} maxCommunicationCost cannot be negative`);
      if (need.minReliability < 0 || need.minReliability > 1) throw new InvariantViolation(`need ${need.id} minReliability must be in [0,1]`);
    }
    for (const invariant of this.#invariants) {
      if (!invariant.check(value)) throw new InvariantViolation(`NanoAgent invariant failed: ${invariant.id}: ${invariant.description}`);
    }
  }
}

function uniqueById(values: Capability[]): Capability[] {
  return [...new Map(values.map(value => [value.id, value])).values()];
}

function uniqueNeeds(values: ConnectionNeed[]): ConnectionNeed[] {
  return [...new Map(values.map(value => [value.id, value])).values()];
}

function dedupeBeliefs(values: Belief[]): Belief[] {
  const map = new Map<string, Belief>();
  for (const belief of values) {
    const current = map.get(belief.proposition);
    if (!current || belief.confidence >= current.confidence) map.set(belief.proposition, belief);
  }
  return [...map.values()];
}
