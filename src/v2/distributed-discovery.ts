import { randomUUID } from "node:crypto";
import { EncryptedTcpTransport, type DecryptedMeshMessage } from "./encrypted-transport.js";
import type {
  AgentAdvertisement,
  AgentCognitivePort,
  DiscoveryCandidate,
  JsonObject,
  JsonValue,
  MeshPeer,
  RelationshipDecision,
  RelationshipProposal,
  RelationshipTerms,
  RemoteRelationship,
} from "./types.js";

interface LocalAgentRecord {
  agent: AgentCognitivePort;
  metadata: JsonObject;
  profile?: Partial<AgentAdvertisement>;
  decide?: (proposal: RelationshipProposal, remote: AgentAdvertisement) => RelationshipDecision | Promise<RelationshipDecision>;
}

interface InternalRelationship extends RemoteRelationship {
  currentTurnAgentId: string;
  localBoundary: JsonObject;
  remoteBoundary: JsonObject;
  pendingRevision: number | undefined;
}

interface PendingNegotiation {
  resolve: (decision: RelationshipDecision) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingSync {
  resolve: (relationship: RemoteRelationship) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DistributedDiscoveryOptions {
  advertisementTtlMs?: number;
  negotiationTimeoutMs?: number;
  synchronizationTimeoutMs?: number;
  maxCandidatesPerAgent?: number;
}

export class DistributedDiscoveryMesh {
  readonly #peers = new Map<string, MeshPeer>();
  readonly #localAgents = new Map<string, LocalAgentRecord>();
  readonly #remoteAdvertisements = new Map<string, AgentAdvertisement>();
  readonly #relationships = new Map<string, InternalRelationship>();
  readonly #pendingNegotiations = new Map<string, PendingNegotiation>();
  readonly #pendingSync = new Map<string, PendingSync>();
  #unsubscribe: (() => void) | undefined;

  constructor(
    readonly nodeId: string,
    readonly transport: EncryptedTcpTransport,
    readonly options: DistributedDiscoveryOptions = {},
  ) {}

  addPeer(peer: MeshPeer): void {
    this.transport.addPeer(peer.identity);
    this.#peers.set(peer.identity.id, structuredClone(peer));
  }

  registerAgent(
    agent: AgentCognitivePort,
    options: {
      metadata?: JsonObject;
      profile?: Partial<AgentAdvertisement>;
      decide?: LocalAgentRecord["decide"];
    } = {},
  ): void {
    this.#localAgents.set(agent.id, {
      agent,
      metadata: structuredClone(options.metadata ?? {}),
      ...(options.profile ? { profile: structuredClone(options.profile) } : {}),
      ...(options.decide ? { decide: options.decide } : {}),
    });
  }

  unregisterAgent(agentId: string): void {
    this.#localAgents.delete(agentId);
    for (const [id, relationship] of this.#relationships) {
      if (relationship.localAgentId === agentId) this.#relationships.delete(id);
    }
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.transport.onMessage((message) => this.#receive(message));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const pending of this.#pendingNegotiations.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Distributed discovery stopped"));
    }
    for (const pending of this.#pendingSync.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Distributed discovery stopped"));
    }
    this.#pendingNegotiations.clear();
    this.#pendingSync.clear();
  }

  localAdvertisements(now = Date.now()): AgentAdvertisement[] {
    return [...this.#localAgents.values()].map((record) => this.#advertisement(record, now));
  }

  remoteAdvertisements(now = Date.now()): AgentAdvertisement[] {
    this.expire(now);
    return [...this.#remoteAdvertisements.values()].map((value) => structuredClone(value));
  }

  relationships(): RemoteRelationship[] {
    return [...this.#relationships.values()].map(({ currentTurnAgentId: _turn, localBoundary: _local, remoteBoundary: _remote, pendingRevision: _pending, ...value }) => structuredClone(value));
  }

  async announceAll(now = Date.now()): Promise<void> {
    const advertisements = this.localAdvertisements(now);
    await Promise.allSettled(
      [...this.#peers.values()].flatMap((peer) => advertisements.map((advertisement) => this.transport.send(
        peer,
        "discovery.advertise",
        advertisement as unknown as JsonValue,
      ))),
    );
  }

  expire(now = Date.now()): void {
    for (const [id, advertisement] of this.#remoteAdvertisements) {
      if (advertisement.expiresAt <= now) this.#remoteAdvertisements.delete(id);
    }
  }

  candidates(now = Date.now()): DiscoveryCandidate[] {
    this.expire(now);
    const remote = [...this.#remoteAdvertisements.values()];
    const candidates: DiscoveryCandidate[] = [];
    for (const record of this.#localAgents.values()) {
      const local = this.#advertisement(record, now);
      const currentRemoteAgents = new Set(
        [...this.#relationships.values()]
          .filter((relationship) => relationship.localAgentId === local.agentId && relationship.state !== "retired")
          .map((relationship) => relationship.remoteAgentId),
      );
      if (local.currentLinks >= local.maxLinks) continue;
      for (const peer of remote) {
        if (currentRemoteAgents.has(peer.agentId) || peer.currentLinks >= peer.maxLinks) continue;
        const candidate = scoreCandidate(local, peer);
        const threshold = Math.max(local.minCompatibility, peer.minCompatibility);
        if (candidate.score >= threshold) candidates.push(candidate);
      }
    }
    return candidates
      .sort((a, b) => b.score - a.score || a.local.agentId.localeCompare(b.local.agentId))
      .slice(0, Math.max(1, this.options.maxCandidatesPerAgent ?? 32));
  }

  async negotiate(candidate: DiscoveryCandidate, terms?: Partial<RelationshipTerms>): Promise<RemoteRelationship> {
    const peer = this.#peers.get(candidate.remote.nodeId);
    if (!peer) throw new Error(`No network peer registered for node ${candidate.remote.nodeId}`);
    const proposal: RelationshipProposal = {
      id: `proposal:${randomUUID()}`,
      proposerNodeId: this.nodeId,
      proposerAgentId: candidate.local.agentId,
      recipientNodeId: candidate.remote.nodeId,
      recipientAgentId: candidate.remote.agentId,
      candidateScore: candidate.score,
      terms: normalizeTerms({
        topics: [...new Set([...candidate.matchedNeeds, ...candidate.reciprocalMatches])],
        payloadMode: "delta",
        heartbeatMs: 30_000,
        maxCommunicationCost: Math.min(candidate.local.maxCommunicationCost, candidate.remote.maxCommunicationCost),
        minInformationGain: 0,
        ...terms,
      }),
      round: 1,
      expiresAt: Date.now() + (this.options.negotiationTimeoutMs ?? 10_000),
    };
    const decision = await this.#requestDecision(peer, proposal);
    if (decision.action === "reject") throw new Error(`Remote relationship rejected: ${decision.reason}`);
    if (decision.action === "counter") {
      const counterProposal: RelationshipProposal = {
        ...proposal,
        id: `proposal:${randomUUID()}`,
        terms: normalizeTerms(decision.terms),
        round: proposal.round + 1,
        expiresAt: Date.now() + (this.options.negotiationTimeoutMs ?? 10_000),
      };
      const second = await this.#requestDecision(peer, counterProposal);
      if (second.action !== "accept") throw new Error(`Remote counter-offer not accepted: ${second.reason}`);
      return this.#installRelationship(counterProposal, second.terms, true);
    }
    return this.#installRelationship(proposal, decision.terms, true);
  }

  async discoverAndConnect(now = Date.now()): Promise<RemoteRelationship[]> {
    await this.announceAll(now);
    const created: RemoteRelationship[] = [];
    const occupied = new Set<string>();
    for (const candidate of this.candidates(now)) {
      if (occupied.has(candidate.local.agentId)) continue;
      try {
        const relationship = await this.negotiate(candidate);
        created.push(relationship);
        occupied.add(candidate.local.agentId);
      } catch {
        // A failed pairwise negotiation does not block other candidates.
      }
    }
    return created;
  }

  async synchronize(relationshipId: string): Promise<RemoteRelationship> {
    const relationship = this.#relationships.get(relationshipId);
    if (!relationship) throw new Error(`Unknown remote relationship ${relationshipId}`);
    if (relationship.state === "retired") throw new Error(`Relationship ${relationshipId} is retired`);
    if (relationship.currentTurnAgentId !== relationship.localAgentId) {
      return this.#publicRelationship(relationship);
    }
    if (relationship.pendingRevision !== undefined) throw new Error(`Relationship ${relationshipId} already has a pending synchronization`);
    const peer = this.#peers.get(relationship.remoteNodeId);
    if (!peer) throw new Error(`Missing peer ${relationship.remoteNodeId}`);
    const record = this.#localAgents.get(relationship.localAgentId);
    if (!record) throw new Error(`Missing local agent ${relationship.localAgentId}`);
    const snapshot = record.agent.snapshot();
    const boundary = structuredClone(snapshot.exposedState ?? {});
    const revision = relationship.revisions + 1;
    relationship.pendingRevision = revision;
    const promise = new Promise<RemoteRelationship>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingSync.delete(`${relationshipId}:${revision}`);
        relationship.pendingRevision = undefined;
        relationship.failures += 1;
        reject(new Error(`Remote synchronization timed out for ${relationshipId}`));
      }, this.options.synchronizationTimeoutMs ?? 5_000);
      this.#pendingSync.set(`${relationshipId}:${revision}`, { resolve, reject, timer });
    });
    await this.transport.send(peer, "relationship.boundary", {
      relationshipId,
      revision,
      agentId: relationship.localAgentId,
      recipientAgentId: relationship.remoteAgentId,
      boundary,
      sentAt: Date.now(),
    });
    return promise;
  }

  async synchronizeAll(): Promise<RemoteRelationship[]> {
    const results = await Promise.allSettled(
      [...this.#relationships.values()]
        .filter((relationship) => relationship.currentTurnAgentId === relationship.localAgentId && relationship.state !== "retired")
        .map((relationship) => this.synchronize(relationship.id)),
    );
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async tick(now = Date.now()): Promise<{ created: RemoteRelationship[]; synchronized: RemoteRelationship[] }> {
    this.expire(now);
    const created = await this.discoverAndConnect(now);
    const synchronized = await this.synchronizeAll();
    return { created, synchronized };
  }

  #advertisement(record: LocalAgentRecord, now: number): AgentAdvertisement {
    const snapshot = record.agent.snapshot();
    const capabilities = snapshot.capabilities ?? [];
    const accepts = [...new Set([
      ...capabilities.flatMap((capability) => capability.accepts ?? []),
      ...(snapshot.needs ?? []).flatMap((need) => need.accepts ?? []),
    ])].sort();
    const produces = [...new Set(capabilities.flatMap((capability) => capability.produces ?? []))].sort();
    const needs = [...new Set((snapshot.needs ?? []).flatMap((need) => need.accepts ?? []))].sort();
    const policy = snapshot.networkPolicy ?? {};
    const ttl = this.options.advertisementTtlMs ?? 60_000;
    const base: AgentAdvertisement = {
      agentId: record.agent.id,
      nodeId: this.nodeId,
      generation: snapshot.generation ?? 0,
      objective: snapshot.objective?.primary ?? "",
      capabilities: capabilities.map((capability) => capability.id).sort(),
      accepts,
      produces,
      needs,
      currentLinks: snapshot.links?.length ?? 0,
      maxLinks: policy.maxLinks ?? 32,
      minCompatibility: policy.minCompatibility ?? 0.35,
      maxCommunicationCost: policy.maxCommunicationCost ?? 8,
      metadata: structuredClone(record.metadata),
      issuedAt: now,
      expiresAt: now + ttl,
    };
    return { ...base, ...(record.profile ?? {}), issuedAt: now, expiresAt: now + ttl };
  }

  async #requestDecision(peer: MeshPeer, proposal: RelationshipProposal): Promise<RelationshipDecision> {
    const promise = new Promise<RelationshipDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingNegotiations.delete(proposal.id);
        reject(new Error(`Relationship negotiation ${proposal.id} timed out`));
      }, this.options.negotiationTimeoutMs ?? 10_000);
      this.#pendingNegotiations.set(proposal.id, { resolve, reject, timer });
    });
    await this.transport.send(peer, "relationship.propose", proposal as unknown as JsonValue);
    return promise;
  }

  #installRelationship(proposal: RelationshipProposal, terms: RelationshipTerms, proposerSide: boolean): RemoteRelationship {
    const id = `relationship:${proposal.id}`;
    const localAgentId = proposerSide ? proposal.proposerAgentId : proposal.recipientAgentId;
    const remoteAgentId = proposerSide ? proposal.recipientAgentId : proposal.proposerAgentId;
    const remoteNodeId = proposerSide ? proposal.recipientNodeId : proposal.proposerNodeId;
    const relationship: InternalRelationship = {
      id,
      localAgentId,
      remoteAgentId,
      remoteNodeId,
      terms: normalizeTerms(terms),
      state: "probation",
      revisions: 0,
      lastActivityAt: Date.now(),
      usefulExchanges: 0,
      failures: 0,
      currentTurnAgentId: proposal.proposerAgentId,
      localBoundary: {},
      remoteBoundary: {},
      pendingRevision: undefined,
    };
    this.#relationships.set(id, relationship);
    return this.#publicRelationship(relationship);
  }

  #publicRelationship(relationship: InternalRelationship): RemoteRelationship {
    const { currentTurnAgentId: _turn, localBoundary: _local, remoteBoundary: _remote, pendingRevision: _pending, ...publicValue } = relationship;
    return structuredClone(publicValue);
  }

  async #receive(message: DecryptedMeshMessage): Promise<void> {
    switch (message.topic) {
      case "discovery.advertise": {
        const advertisement = message.payload as unknown as AgentAdvertisement;
        if (advertisement.nodeId !== message.sender || advertisement.expiresAt <= Date.now()) return;
        this.#remoteAdvertisements.set(advertisement.agentId, structuredClone(advertisement));
        return;
      }
      case "discovery.withdraw": {
        const payload = message.payload as JsonObject;
        const agentId = String(payload.agentId ?? "");
        if (agentId) this.#remoteAdvertisements.delete(agentId);
        return;
      }
      case "relationship.propose": {
        await this.#handleProposal(message);
        return;
      }
      case "relationship.decision": {
        const payload = message.payload as JsonObject;
        const proposalId = String(payload.proposalId ?? "");
        const pending = this.#pendingNegotiations.get(proposalId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pendingNegotiations.delete(proposalId);
        pending.resolve(payload.decision as unknown as RelationshipDecision);
        return;
      }
      case "relationship.boundary": {
        await this.#handleBoundary(message);
        return;
      }
      case "relationship.ack": {
        this.#handleAck(message);
        return;
      }
      default:
        return;
    }
  }

  async #handleProposal(message: DecryptedMeshMessage): Promise<void> {
    const proposal = message.payload as unknown as RelationshipProposal;
    if (proposal.recipientNodeId !== this.nodeId || proposal.proposerNodeId !== message.sender || proposal.expiresAt <= Date.now()) return;
    const peer = this.#peers.get(message.sender);
    const local = this.#localAgents.get(proposal.recipientAgentId);
    const remote = this.#remoteAdvertisements.get(proposal.proposerAgentId);
    if (!peer || !local || !remote) return;
    const decision = local.decide
      ? await local.decide(proposal, structuredClone(remote))
      : defaultDecision(this.#advertisement(local, Date.now()), remote, proposal);
    if (decision.action === "accept") this.#installRelationship(proposal, decision.terms, false);
    await this.transport.send(peer, "relationship.decision", {
      proposalId: proposal.id,
      decision: decision as unknown as JsonValue,
    });
  }

  async #handleBoundary(message: DecryptedMeshMessage): Promise<void> {
    const payload = message.payload as JsonObject;
    const relationshipId = String(payload.relationshipId ?? "");
    const relationship = this.#relationships.get(relationshipId);
    const peer = this.#peers.get(message.sender);
    if (!relationship || !peer || relationship.remoteNodeId !== message.sender) return;
    const revision = Number(payload.revision);
    const agentId = String(payload.agentId ?? "");
    if (
      !Number.isSafeInteger(revision)
      || revision !== relationship.revisions + 1
      || agentId !== relationship.remoteAgentId
      || relationship.currentTurnAgentId !== relationship.remoteAgentId
    ) {
      relationship.failures += 1;
      return;
    }
    const boundary = (payload.boundary ?? {}) as JsonObject;
    relationship.remoteBoundary = structuredClone(boundary);
    relationship.revisions = revision;
    relationship.currentTurnAgentId = relationship.localAgentId;
    relationship.lastActivityAt = Date.now();
    relationship.usefulExchanges += 1;
    if (relationship.usefulExchanges >= 2) relationship.state = "active";
    const local = this.#localAgents.get(relationship.localAgentId)?.agent;
    local?.setEphemeral?.({
      distributedBoundaries: {
        [relationship.id]: {
          sourceNodeId: relationship.remoteNodeId,
          sourceAgentId: relationship.remoteAgentId,
          revision,
          boundary,
          observedAt: Date.now(),
        },
      },
    });
    await this.transport.send(peer, "relationship.ack", {
      relationshipId,
      revision,
      accepted: true,
    });
  }

  #handleAck(message: DecryptedMeshMessage): void {
    const payload = message.payload as JsonObject;
    const relationshipId = String(payload.relationshipId ?? "");
    const revision = Number(payload.revision);
    const pending = this.#pendingSync.get(`${relationshipId}:${revision}`);
    const relationship = this.#relationships.get(relationshipId);
    if (!pending || !relationship || relationship.remoteNodeId !== message.sender) return;
    clearTimeout(pending.timer);
    this.#pendingSync.delete(`${relationshipId}:${revision}`);
    relationship.pendingRevision = undefined;
    relationship.revisions = revision;
    relationship.currentTurnAgentId = relationship.remoteAgentId;
    relationship.lastActivityAt = Date.now();
    relationship.usefulExchanges += 1;
    relationship.localBoundary = structuredClone(
      this.#localAgents.get(relationship.localAgentId)?.agent.snapshot().exposedState ?? {},
    );
    if (relationship.usefulExchanges >= 2) relationship.state = "active";
    pending.resolve(this.#publicRelationship(relationship));
  }
}

function scoreCandidate(local: AgentAdvertisement, remote: AgentAdvertisement): DiscoveryCandidate {
  const localNeeds = new Set(local.needs.length > 0 ? local.needs : local.accepts);
  const remoteNeeds = new Set(remote.needs.length > 0 ? remote.needs : remote.accepts);
  const matchedNeeds = remote.produces.filter((topic) => localNeeds.has(topic));
  const reciprocalMatches = local.produces.filter((topic) => remoteNeeds.has(topic));
  const objectiveTokens = new Set(local.objective.toLowerCase().split(/\W+/).filter(Boolean));
  const remoteTokens = new Set(remote.objective.toLowerCase().split(/\W+/).filter(Boolean));
  const objectiveOverlap = [...objectiveTokens].filter((token) => remoteTokens.has(token)).length;
  const objectiveDenominator = Math.max(1, new Set([...objectiveTokens, ...remoteTokens]).size);
  const objectiveAffinity = objectiveOverlap / objectiveDenominator;
  const forward = matchedNeeds.length / Math.max(1, localNeeds.size);
  const reverse = reciprocalMatches.length / Math.max(1, remoteNeeds.size);
  const reciprocity = matchedNeeds.length > 0 && reciprocalMatches.length > 0 ? 1 : 0;
  const score = clamp01(0.5 * forward + 0.25 * reverse + 0.15 * reciprocity + 0.1 * objectiveAffinity);
  return {
    local: structuredClone(local),
    remote: structuredClone(remote),
    score,
    matchedNeeds,
    reciprocalMatches,
  };
}

function defaultDecision(local: AgentAdvertisement, remote: AgentAdvertisement, proposal: RelationshipProposal): RelationshipDecision {
  if (local.currentLinks >= local.maxLinks) return { action: "reject", reason: "local relationship capacity exhausted" };
  if (proposal.candidateScore < local.minCompatibility) return { action: "reject", reason: "compatibility below local threshold" };
  const communicationLimit = Math.min(local.maxCommunicationCost, remote.maxCommunicationCost);
  if (proposal.terms.maxCommunicationCost > communicationLimit) {
    return {
      action: "counter",
      reason: "reduce communication budget",
      terms: normalizeTerms({ ...proposal.terms, maxCommunicationCost: communicationLimit }),
    };
  }
  return { action: "accept", terms: normalizeTerms(proposal.terms), reason: "capabilities and local policy are compatible" };
}

function normalizeTerms(terms: RelationshipTerms): RelationshipTerms {
  return {
    topics: [...new Set(terms.topics)].sort(),
    payloadMode: terms.payloadMode,
    heartbeatMs: Math.max(100, Math.floor(terms.heartbeatMs)),
    maxCommunicationCost: Math.max(0, terms.maxCommunicationCost),
    minInformationGain: Math.max(0, terms.minInformationGain),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
