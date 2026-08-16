import { ProtocolViolation } from "../core/errors.js";
import { LinkProtocol } from "../core/link-protocol.js";
import { commonTopics, isEmptyProtocolPatch, negotiateInitialTerms, protocolPatchBetween } from "../core/protocol-terms.js";
import type {
  AgentId,
  DiscoveryMatch,
  EvolutionError,
  EvolutionOptions,
  EvolutionReport,
  JsonObject,
  LinkId,
  NegotiationId,
  NegotiationSnapshot,
  ProtocolPatch,
  ProtocolTerms,
  TopologyEvent,
  TopologyEventType
} from "../core/types.js";
import {
  applyProtocolPatch,
  deepEqual,
  diffJson,
  jsonByteLength,
  pairKey
} from "../core/utils.js";
import { DiscoveryMesh } from "./discovery-mesh.js";
import { NegotiationSession } from "./negotiation.js";
import type { Universe } from "./universe.js";

const SYNCHRONIZABLE_LINK_STATES = new Set([
  "probation",
  "active",
  "strengthening",
  "weakening",
  "conflicted",
  "dormant"
]);

const ADAPTABLE_LINK_STATES = new Set([
  "active",
  "strengthening",
  "weakening",
  "conflicted"
]);

/**
 * Advances local agent/link processes without deciding a global architecture.
 *
 * The runtime is deliberately a substrate rather than a manager:
 * - agents publish their own capability boundary;
 * - each agent independently scores visible peers;
 * - relationship admission is pairwise and alternating;
 * - every link serializes only its own state while independent links advance
 *   concurrently;
 * - topology is an outcome of accepted, useful relationships.
 */
export class TopologyRuntime {
  readonly discovery = new DiscoveryMesh();
  readonly negotiations = new Map<NegotiationId, NegotiationSnapshot>();

  #universe: Universe;
  #events: TopologyEvent[] = [];
  #eventSeq = 0;
  #rejectionCooldown = new Map<string, number>();

  constructor(universe: Universe) {
    this.#universe = universe;
  }

  events(): TopologyEvent[] {
    return structuredClone(this.#events);
  }

  recordAgentCreated(agentId: AgentId, now = Date.now()): void {
    this.#emit(now, "agent_created", {
      actor: "runtime",
      agentId,
      detail: { lifecycle: this.#universe.requireAgent(agentId).lifecycle }
    });
  }

  async evolve(options: EvolutionOptions = {}): Promise<EvolutionReport> {
    const rounds = Math.max(1, Math.floor(options.rounds ?? 1));
    const baseNow = options.now ?? Date.now();
    const stepMs = Math.max(0, options.stepMs ?? 1);
    const maxTurns = Math.max(0, Math.floor(options.maxLinkTurnsPerRound ?? 2));
    const maxNewLinks = Math.max(0, Math.floor(options.maxNewLinksPerAgentPerRound ?? 1));
    const report = emptyReport(rounds);
    const eventOffset = this.#events.length;

    for (let round = 0; round < rounds; round += 1) {
      const now = baseNow + round * stepMs;

      if (options.lifecycleReview !== false) this.#reviewLifecycle(now, report);

      if (options.discovery !== false) {
        this.#publishAdvertisements(now, report);
        if (maxNewLinks > 0) await this.#discoverAndNegotiate(now, maxNewLinks, report);
      }

      if (options.synchronization !== false && maxTurns > 0) {
        await this.#synchronizeAll(now, maxTurns, report);
      }

      if (options.protocolAdaptation !== false) {
        await this.#adaptProtocols(now, report);
      }

    }

    report.linksCreated = unique(report.linksCreated);
    report.linksPromoted = unique(report.linksPromoted);
    report.linksDormant = unique(report.linksDormant);
    report.linksReactivated = unique(report.linksReactivated);
    report.linksRetired = unique(report.linksRetired);
    report.protocolsAdapted = unique(report.protocolsAdapted);
    report.synchronizedLinks = unique(report.synchronizedLinks);
    report.rejectedNegotiations = unique(report.rejectedNegotiations);
    report.deferredNegotiations = unique(report.deferredNegotiations);
    report.events = structuredClone(this.#events.slice(eventOffset));
    return report;
  }

  #publishAdvertisements(now: number, report: EvolutionReport): void {
    this.discovery.expire(now);
    for (const agent of this.#universe.agents.values()) {
      if (!agent.isNetworkEligible()) {
        this.discovery.withdraw(agent.id);
        continue;
      }
      try {
        const advertisement = agent.advertisement(now);
        this.discovery.publish(advertisement);
        report.advertisements += 1;
        this.#emit(now, "advertisement_published", {
          actor: agent.id,
          agentId: agent.id,
          detail: {
            accepts: advertisement.accepts,
            produces: advertisement.produces,
            currentLinks: advertisement.currentLinks,
            expiresAt: advertisement.expiresAt
          }
        });
      } catch (error) {
        this.#captureError(report, now, "agent", agent.id, error);
      }
    }
  }

  async #discoverAndNegotiate(now: number, maxNewLinks: number, report: EvolutionReport): Promise<void> {
    const candidateLists = await Promise.all(
      [...this.#universe.agents.values()]
        .filter(agent => agent.isNetworkEligible() && agent.remainingLinkCapacity() > 0)
        .map(async agent => {
          try {
            const neighbors = new Set(this.#universe.neighbors(agent.id));
            const matches = await agent.discover(this.discovery.visibleTo(agent.id, now), neighbors, now);
            return { agentId: agent.id, matches };
          } catch (error) {
            this.#captureError(report, now, "agent", agent.id, error);
            return { agentId: agent.id, matches: [] as DiscoveryMatch[] };
          }
        })
    );

    const pairCandidates = new Map<string, DiscoveryMatch>();
    for (const { agentId, matches } of candidateLists) {
      for (const match of matches) {
        report.candidates += 1;
        this.#emit(now, "candidate_selected", {
          actor: agentId,
          agentId,
          peerId: match.peer,
          detail: {
            score: match.score,
            forwardMatches: match.forwardMatches,
            reverseMatches: match.reverseMatches,
            reasons: match.reasons
          }
        });
        const key = pairKey(match.seeker, match.peer);
        const current = pairCandidates.get(key);
        if (!current || match.score > current.score || (match.score === current.score && match.seeker < current.seeker)) {
          pairCandidates.set(key, match);
        }
      }
    }

    const acceptedByAgent = new Map<AgentId, number>();
    const ordered = [...pairCandidates.values()].sort((a, b) => b.score - a.score || pairKey(a.seeker, a.peer).localeCompare(pairKey(b.seeker, b.peer)));

    for (const match of ordered) {
      const key = pairKey(match.seeker, match.peer);
      if ((this.#rejectionCooldown.get(key) ?? 0) > now) continue;
      if (this.#universe.findLinkBetween(match.seeker, match.peer)) continue;

      const seeker = this.#universe.agents.get(match.seeker);
      const peer = this.#universe.agents.get(match.peer);
      if (!seeker || !peer) continue;
      if (seeker.remainingLinkCapacity() === 0 || peer.remainingLinkCapacity() === 0) continue;
      if ((acceptedByAgent.get(seeker.id) ?? 0) >= maxNewLinks || (acceptedByAgent.get(peer.id) ?? 0) >= maxNewLinks) continue;

      const leftAdvertisement = this.discovery.get(seeker.id, now);
      const rightAdvertisement = this.discovery.get(peer.id, now);
      if (!leftAdvertisement || !rightAdvertisement) continue;
      const terms = negotiateInitialTerms(leftAdvertisement, rightAdvertisement, commonTopics(leftAdvertisement, rightAdvertisement));
      if (!terms) continue;

      const session = new NegotiationSession({
        purpose: "formation",
        left: leftAdvertisement,
        right: rightAdvertisement,
        match,
        terms,
        now
      });
      report.negotiations += 1;
      this.#emit(now, "proposal_emitted", {
        actor: seeker.id,
        agentId: seeker.id,
        peerId: peer.id,
        negotiationId: session.id,
        detail: { score: match.score, terms: terms as unknown as JsonObject }
      });

      const seekerLifecycle = seeker.lifecycle;
      const peerLifecycle = peer.lifecycle;
      seeker.beginNegotiation();
      peer.beginNegotiation();

      let snapshot: NegotiationSnapshot;
      try {
        snapshot = await session.run(id => this.#universe.requireAgent(id), now);
      } catch (error) {
        this.#restoreLifecycle(seeker, seekerLifecycle);
        this.#restoreLifecycle(peer, peerLifecycle);
        this.#captureError(report, now, "negotiation", session.id, error);
        this.#rejectionCooldown.set(key, now + Math.max(seeker.snapshot().networkPolicy.rejectionCooldownMs, peer.snapshot().networkPolicy.rejectionCooldownMs));
        continue;
      }
      this.#restoreLifecycle(seeker, seekerLifecycle);
      this.#restoreLifecycle(peer, peerLifecycle);
      this.negotiations.set(session.id, snapshot);

      const counters = snapshot.transcript.filter(record => record.action === "counter");
      report.counterOffers += counters.length;
      for (const counter of counters) {
        this.#emit(counter.at, "negotiation_countered", {
          actor: counter.actor,
          agentId: counter.actor,
          peerId: counter.actor === seeker.id ? peer.id : seeker.id,
          negotiationId: session.id,
          detail: { round: counter.round, reason: counter.reason }
        });
      }

      if (snapshot.status === "accepted" && snapshot.agreedTerms) {
        try {
          const link = new LinkProtocol({
            left: seeker.id,
            right: peer.id,
            lifecycle: "probation",
            terms: snapshot.agreedTerms,
            state: {
              agreement: {
                negotiationId: session.id,
                compatibility: match.score,
                topics: commonTopics(leftAdvertisement, rightAdvertisement)
              }
            },
            now
          });
          this.#universe.attachLink(link);
          acceptedByAgent.set(seeker.id, (acceptedByAgent.get(seeker.id) ?? 0) + 1);
          acceptedByAgent.set(peer.id, (acceptedByAgent.get(peer.id) ?? 0) + 1);
          report.acceptedNegotiations += 1;
          report.linksCreated.push(link.id);
          this.#emit(now, "negotiation_accepted", {
            actor: peer.id,
            agentId: seeker.id,
            peerId: peer.id,
            linkId: link.id,
            negotiationId: session.id,
            detail: { rounds: snapshot.currentOffer.round }
          });
          this.#emit(now, "link_created", {
            actor: "runtime",
            agentId: seeker.id,
            peerId: peer.id,
            linkId: link.id,
            negotiationId: session.id,
            detail: { lifecycle: "probation", strength: link.snapshot().strength }
          });
          this.#emit(now, "link_probation", {
            actor: "runtime",
            agentId: seeker.id,
            peerId: peer.id,
            linkId: link.id,
            negotiationId: session.id,
            detail: { requiredInteractions: snapshot.agreedTerms.probation.requiredInteractions }
          });
        } catch (error) {
          this.#captureError(report, now, "negotiation", session.id, error);
        }
        continue;
      }

      const cooldown = Math.max(seeker.snapshot().networkPolicy.rejectionCooldownMs, peer.snapshot().networkPolicy.rejectionCooldownMs);
      this.#rejectionCooldown.set(key, now + cooldown);
      if (snapshot.status === "deferred") {
        report.deferredNegotiations.push(session.id);
        this.#emit(now, "negotiation_deferred", {
          actor: snapshot.currentOffer.recipient,
          agentId: seeker.id,
          peerId: peer.id,
          negotiationId: session.id,
          detail: { reason: snapshot.rejectionReason ?? "deferred" }
        });
      } else {
        report.rejectedNegotiations.push(session.id);
        this.#emit(now, "negotiation_rejected", {
          actor: snapshot.currentOffer.recipient,
          agentId: seeker.id,
          peerId: peer.id,
          negotiationId: session.id,
          detail: { status: snapshot.status, reason: snapshot.rejectionReason ?? "rejected" }
        });
      }
    }
  }

  async #synchronizeAll(now: number, maxTurns: number, report: EvolutionReport): Promise<void> {
    const links = [...this.#universe.links.values()].filter(link => SYNCHRONIZABLE_LINK_STATES.has(link.snapshot().lifecycle));
    await Promise.all(links.map(link => this.#synchronizeLink(link, now, maxTurns, report)));
  }

  async #synchronizeLink(link: LinkProtocol, now: number, maxTurns: number, report: EvolutionReport): Promise<void> {
    const atStart = link.snapshot();
    const lastActivation = atStart.metrics.lastActivatedAt;
    if (atStart.lifecycle === "dormant") {
      const lastDormantActivity = lastActivation ?? atStart.updatedAt;
      if (now - lastDormantActivity < atStart.terms.heartbeatMs) return;
    } else if (lastActivation !== undefined && now - lastActivation < atStart.terms.minActivationIntervalMs) {
      return;
    }

    let synchronized = false;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const before = link.snapshot();
      if (!SYNCHRONIZABLE_LINK_STATES.has(before.lifecycle)) break;
      const authorId = link.currentTurnAgent();
      const peerId = link.other(authorId);
      const author = this.#universe.agents.get(authorId);
      const peer = this.#universe.agents.get(peerId);
      if (!author || !peer) {
        this.#captureError(report, now, "link", link.id, new ProtocolViolation("link participant missing"));
        break;
      }

      try {
        const boundary = await author.projectBoundary(peer.snapshot(), before);
        if (boundary === null) {
          link.passTurn(authorId, "local agent emitted no boundary", now);
          report.unchangedBoundaries += 1;
          this.#emit(now, "boundary_unchanged", {
            actor: authorId,
            agentId: authorId,
            peerId,
            linkId: link.id,
            detail: { reason: "null boundary" }
          });
          this.#emit(now, "turn_passed", {
            actor: authorId,
            agentId: authorId,
            peerId,
            linkId: link.id,
            detail: { next: link.currentTurnAgent() }
          });
          continue;
        }

        const side = link.sideOf(authorId);
        const previousBoundary = isJsonObject(before.state[side]) ? before.state[side] : {};
        const payload = this.#boundaryPayload(before.terms.payloadMode, previousBoundary, boundary);
        if (Object.keys(payload).length === 0) {
          if (before.lifecycle === "dormant") {
            report.unchangedBoundaries += 1;
            this.#emit(now, "boundary_unchanged", {
              actor: authorId,
              agentId: authorId,
              peerId,
              linkId: link.id,
              detail: { side, dormantProbe: true }
            });
            break;
          }
          link.passTurn(authorId, "boundary unchanged", now);
          report.unchangedBoundaries += 1;
          this.#emit(now, "boundary_unchanged", {
            actor: authorId,
            agentId: authorId,
            peerId,
            linkId: link.id,
            detail: { side }
          });
          this.#emit(now, "turn_passed", {
            actor: authorId,
            agentId: authorId,
            peerId,
            linkId: link.id,
            detail: { next: link.currentTurnAgent() }
          });
          continue;
        }

        const delta: JsonObject = { [side]: payload };
        const communicationCost = Math.max(0.0001, jsonByteLength(delta) / 1024);
        const informationGain = Math.max(before.terms.minInformationGain, countLeaves(payload));
        const revision = link.mutate({
          author: authorId,
          delta,
          evidence: [`boundary:${authorId}`, `payload:${before.terms.payloadMode}`],
          informationGain,
          utility: 1,
          communicationCost,
          synchronization: true
        }, now);
        peer.observeBoundary(link.id, authorId, boundary, now);
        if (before.lifecycle === "dormant") {
          link.activate(now);
          report.linksReactivated.push(link.id);
          this.#emit(now, "link_reactivated", {
            actor: authorId,
            agentId: authorId,
            peerId,
            linkId: link.id,
            detail: { strength: link.snapshot().strength, reason: "new boundary information" }
          });
        }
        synchronized = true;
        this.#emit(now, "boundary_synchronized", {
          actor: authorId,
          agentId: authorId,
          peerId,
          linkId: link.id,
          detail: {
            revision: revision.id,
            side,
            informationGain,
            communicationCost
          }
        });
      } catch (error) {
        link.recordFailure();
        this.#captureError(report, now, "agent", authorId, error, { linkId: link.id, peerId });
        this.#emit(now, "boundary_rejected", {
          actor: authorId,
          agentId: authorId,
          peerId,
          linkId: link.id,
          detail: { reason: errorMessage(error) }
        });
        break;
      }
    }

    if (synchronized) report.synchronizedLinks.push(link.id);
    this.#reviewOneLink(link, now, report);
  }

  #boundaryPayload(mode: ProtocolTerms["payloadMode"], previous: JsonObject, next: JsonObject): JsonObject {
    if (mode === "full_state" || mode === "structured") return deepEqual(previous, next) ? {} : structuredClone(next);
    return diffJson(previous, next);
  }

  async #adaptProtocols(now: number, report: EvolutionReport): Promise<void> {
    const links = [...this.#universe.links.values()].filter(link => {
      const snapshot = link.snapshot();
      return ADAPTABLE_LINK_STATES.has(snapshot.lifecycle) && link.shouldReviewProtocol();
    });
    await Promise.all(links.map(link => this.#adaptOneProtocol(link, now, report)));
  }

  async #adaptOneProtocol(link: LinkProtocol, now: number, report: EvolutionReport): Promise<void> {
    const before = link.snapshot();
    const proposerId = link.currentTurnAgent();
    const peerId = link.other(proposerId);
    const proposer = this.#universe.agents.get(proposerId);
    const peer = this.#universe.agents.get(peerId);
    if (!proposer || !peer) return;

    let patch: ProtocolPatch | null = null;
    try {
      patch = await proposer.suggestProtocolPatch(peer.snapshot(), before);
      if (!patch) patch = link.recommendProtocolPatch();
    } catch (error) {
      this.#captureError(report, now, "agent", proposerId, error, { linkId: link.id, peerId });
      link.markProtocolReviewed();
      return;
    }
    if (!patch || isEmptyProtocolPatch(patch)) {
      link.markProtocolReviewed();
      this.#emit(now, "protocol_reviewed", {
        actor: proposerId,
        agentId: proposerId,
        peerId,
        linkId: link.id,
        detail: { changed: false }
      });
      return;
    }

    const proposedTerms = applyProtocolPatch(before.terms, patch);
    const proposerAdvertisement = proposer.advertisement(now);
    const peerAdvertisement = peer.advertisement(now);
    const match: DiscoveryMatch = {
      seeker: proposerId,
      peer: peerId,
      score: 1,
      forwardMatches: commonTopics(proposerAdvertisement, peerAdvertisement),
      reverseMatches: commonTopics(peerAdvertisement, proposerAdvertisement),
      objectiveAffinity: 1,
      reciprocity: 1,
      estimatedCommunicationCost: proposedTerms.maxCommunicationCost,
      reasons: ["existing relationship protocol review"]
    };
    const session = new NegotiationSession({
      purpose: "renegotiation",
      left: proposerAdvertisement,
      right: peerAdvertisement,
      match,
      terms: proposedTerms,
      now,
      linkId: link.id
    });
    this.#emit(now, "protocol_proposed", {
      actor: proposerId,
      agentId: proposerId,
      peerId,
      linkId: link.id,
      negotiationId: session.id,
      detail: { patch: patch as unknown as JsonObject }
    });

    const previousLifecycle = before.lifecycle;
    link.beginRenegotiation(now);
    let snapshot: NegotiationSnapshot;
    try {
      snapshot = await session.run(id => this.#universe.requireAgent(id), now);
    } catch (error) {
      link.resumeAfterRenegotiation(previousLifecycle, now);
      link.markProtocolReviewed();
      this.#captureError(report, now, "negotiation", session.id, error, { linkId: link.id });
      return;
    }
    this.negotiations.set(session.id, snapshot);

    if (snapshot.status === "accepted" && snapshot.agreedTerms) {
      const acceptedPatch = protocolPatchBetween(before.terms, snapshot.agreedTerms);
      if (!isEmptyProtocolPatch(acceptedPatch)) {
        try {
          link.mutateProtocol(proposerId, acceptedPatch, [`negotiation:${session.id}`], now);
          report.protocolsAdapted.push(link.id);
          this.#emit(now, "protocol_adapted", {
            actor: proposerId,
            agentId: proposerId,
            peerId,
            linkId: link.id,
            negotiationId: session.id,
            detail: { patch: acceptedPatch as unknown as JsonObject }
          });
        } catch (error) {
          link.markProtocolReviewed();
          this.#captureError(report, now, "link", link.id, error, { negotiationId: session.id });
        }
      } else {
        link.markProtocolReviewed();
        this.#emit(now, "protocol_reviewed", {
          actor: proposerId,
          agentId: proposerId,
          peerId,
          linkId: link.id,
          negotiationId: session.id,
          detail: { changed: false, reason: "agreed terms equal current terms" }
        });
      }
      link.resumeAfterRenegotiation(previousLifecycle, now);
      return;
    }

    link.markProtocolReviewed();
    link.resumeAfterRenegotiation(previousLifecycle, now);
    this.#emit(now, "protocol_rejected", {
      actor: peerId,
      agentId: proposerId,
      peerId,
      linkId: link.id,
      negotiationId: session.id,
      detail: { status: snapshot.status, reason: snapshot.rejectionReason ?? "renegotiation rejected", previousLifecycle }
    });
  }

  #reviewLifecycle(now: number, report: EvolutionReport): void {
    this.discovery.expire(now);

    for (const agent of this.#universe.agents.values()) {
      const snapshot = agent.snapshot();
      if (snapshot.ttlMs !== undefined && snapshot.lifecycle !== "retired" && now - snapshot.createdAt > snapshot.ttlMs) {
        agent.retire();
        this.discovery.withdraw(agent.id);
        this.#emit(now, "agent_retired", {
          actor: "runtime",
          agentId: agent.id,
          detail: { reason: "ttl expired" }
        });
      }
    }

    for (const link of [...this.#universe.links.values()]) this.#reviewOneLink(link, now, report);
  }

  #reviewOneLink(link: LinkProtocol, now: number, report: EvolutionReport): void {
    const before = link.snapshot();
    link.decay(now);
    const afterLifecycle = link.reviewLifecycle(now);
    const after = link.snapshot();

    if (before.lifecycle === "probation" && afterLifecycle === "active") {
      report.linksPromoted.push(link.id);
      this.#emit(now, "link_promoted", {
        actor: "runtime",
        agentId: after.left,
        peerId: after.right,
        linkId: link.id,
        detail: { strength: after.strength, synchronizations: after.metrics.successfulSynchronizations }
      });
    }
    if (before.lifecycle !== "dormant" && afterLifecycle === "dormant") {
      report.linksDormant.push(link.id);
      this.#emit(now, "link_dormant", {
        actor: "runtime",
        agentId: after.left,
        peerId: after.right,
        linkId: link.id,
        detail: { strength: after.strength }
      });
    }
    if (before.lifecycle !== "strengthening" && afterLifecycle === "strengthening") {
      this.#emit(now, "link_strengthened", {
        actor: "runtime",
        agentId: after.left,
        peerId: after.right,
        linkId: link.id,
        detail: { strength: after.strength }
      });
    }
    if (before.lifecycle !== "weakening" && afterLifecycle === "weakening") {
      this.#emit(now, "link_weakened", {
        actor: "runtime",
        agentId: after.left,
        peerId: after.right,
        linkId: link.id,
        detail: { strength: after.strength }
      });
    }
    if (afterLifecycle === "retired") {
      report.linksRetired.push(link.id);
      this.#emit(now, "link_retired", {
        actor: "runtime",
        agentId: after.left,
        peerId: after.right,
        linkId: link.id,
        detail: { previousLifecycle: before.lifecycle, strength: after.strength }
      });
      this.#universe.removeLink(link.id);
    }
  }

  #restoreLifecycle(agent: ReturnType<Universe["requireAgent"]>, lifecycle: ReturnType<ReturnType<Universe["requireAgent"]>["snapshot"]>["lifecycle"]): void {
    if (agent.lifecycle !== "negotiating") return;
    if (lifecycle === "waiting") agent.wait();
    else if (lifecycle === "dormant") agent.sleep();
    else agent.endNegotiation();
  }

  #captureError(
    report: EvolutionReport,
    now: number,
    scope: EvolutionError["scope"],
    entityId: string,
    error: unknown,
    context: { linkId?: LinkId; peerId?: AgentId; negotiationId?: NegotiationId } = {}
  ): void {
    const message = errorMessage(error);
    report.errors.push({ scope, entityId, message });
    this.#emit(now, "runtime_error", {
      actor: "runtime",
      ...(context.peerId === undefined ? {} : { peerId: context.peerId }),
      ...(context.linkId === undefined ? {} : { linkId: context.linkId }),
      ...(context.negotiationId === undefined ? {} : { negotiationId: context.negotiationId }),
      detail: { scope, entityId, message }
    });
  }

  #emit(
    at: number,
    type: TopologyEventType,
    fields: {
      actor?: AgentId | "runtime";
      agentId?: AgentId;
      peerId?: AgentId;
      linkId?: LinkId;
      negotiationId?: NegotiationId;
      detail: JsonObject;
    }
  ): void {
    const event: TopologyEvent = {
      seq: ++this.#eventSeq,
      at,
      type,
      detail: structuredClone(fields.detail),
      ...(fields.actor === undefined ? {} : { actor: fields.actor }),
      ...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
      ...(fields.peerId === undefined ? {} : { peerId: fields.peerId }),
      ...(fields.linkId === undefined ? {} : { linkId: fields.linkId }),
      ...(fields.negotiationId === undefined ? {} : { negotiationId: fields.negotiationId })
    };
    this.#events.push(event);
  }
}

function emptyReport(rounds: number): EvolutionReport {
  return {
    rounds,
    advertisements: 0,
    candidates: 0,
    negotiations: 0,
    counterOffers: 0,
    acceptedNegotiations: 0,
    rejectedNegotiations: [],
    deferredNegotiations: [],
    linksCreated: [],
    linksPromoted: [],
    linksDormant: [],
    linksReactivated: [],
    linksRetired: [],
    protocolsAdapted: [],
    synchronizedLinks: [],
    unchangedBoundaries: 0,
    errors: [],
    events: []
  };
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countLeaves(value: JsonObject): number {
  let count = 0;
  for (const child of Object.values(value)) {
    if (isJsonObject(child)) count += countLeaves(child);
    else if (Array.isArray(child)) count += Math.max(1, child.length);
    else count += 1;
  }
  return Math.max(1, count);
}
