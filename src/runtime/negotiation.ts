import { ProtocolViolation } from "../core/errors.js";
import { NanoAgent } from "../core/nano-agent.js";
import { termsSupportedBy } from "../core/protocol-terms.js";
import type {
  ConnectionOffer,
  DiscoveryAdvertisement,
  DiscoveryMatch,
  NegotiationDecision,
  NegotiationSnapshot,
  NegotiationStatus,
  ProtocolTerms
} from "../core/types.js";
import { deepClone, negotiationId } from "../core/utils.js";

export interface NegotiationSpec {
  purpose?: "formation" | "renegotiation";
  left: DiscoveryAdvertisement;
  right: DiscoveryAdvertisement;
  match: DiscoveryMatch;
  terms: ProtocolTerms;
  now?: number;
  linkId?: ConnectionOffer["linkId"];
}

export class NegotiationSession {
  #s: NegotiationSnapshot;

  constructor(spec: NegotiationSpec) {
    const now = spec.now ?? Date.now();
    const id = negotiationId();
    const expiresAt = now + Math.min(spec.left.policy.proposalTtlMs, spec.right.policy.proposalTtlMs);
    const offer: ConnectionOffer = {
      id,
      purpose: spec.purpose ?? "formation",
      ...(spec.linkId === undefined ? {} : { linkId: spec.linkId }),
      round: 1,
      proposer: spec.left.agentId,
      recipient: spec.right.agentId,
      proposerAdvertisement: deepClone(spec.left),
      recipientAdvertisement: deepClone(spec.right),
      match: deepClone(spec.match),
      terms: deepClone(spec.terms),
      createdAt: now,
      expiresAt
    };
    this.#s = {
      id,
      purpose: offer.purpose,
      left: spec.left.agentId,
      right: spec.right.agentId,
      status: "proposed",
      currentOffer: offer,
      transcript: [{ round: 1, actor: offer.proposer, action: "propose", terms: deepClone(offer.terms), reason: "initial pairwise proposal", at: now }],
      createdAt: now,
      updatedAt: now
    };
  }

  get id() { return this.#s.id; }
  get status(): NegotiationStatus { return this.#s.status; }
  snapshot(): NegotiationSnapshot { return deepClone(this.#s); }

  async run(resolveAgent: (id: ConnectionOffer["recipient"]) => NanoAgent, now = Date.now()): Promise<NegotiationSnapshot> {
    while (this.#s.status === "proposed" || this.#s.status === "countered") {
      const offer = this.#s.currentOffer;
      if (offer.expiresAt <= now) {
        this.#finish("expired", "proposal expired", now);
        break;
      }
      const recipient = resolveAgent(offer.recipient);
      const decision = await recipient.evaluateOffer(offer, now);
      this.#recordDecision(decision, now);
      if (decision.action === "accept") {
        if (!termsSupportedBy(offer.terms, offer.proposerAdvertisement) || !termsSupportedBy(offer.terms, offer.recipientAdvertisement)) {
          this.#finish("rejected", "accepted terms are not supported by both participants", now);
          break;
        }
        this.#s = { ...this.#s, status: "accepted", agreedTerms: deepClone(offer.terms), updatedAt: now };
        break;
      }
      if (decision.action === "reject") {
        this.#finish("rejected", decision.reason, now);
        break;
      }
      if (decision.action === "defer") {
        this.#finish("deferred", decision.reason, now);
        break;
      }
      if (!decision.counterTerms) throw new ProtocolViolation("counter decision requires counterTerms");
      const maxRounds = Math.min(offer.proposerAdvertisement.policy.maxNegotiationRounds, offer.recipientAdvertisement.policy.maxNegotiationRounds);
      if (offer.round >= maxRounds) {
        this.#finish("rejected", "negotiation round limit reached", now);
        break;
      }
      const nextRound = offer.round + 1;
      const nextOffer: ConnectionOffer = {
        ...offer,
        round: nextRound,
        proposer: offer.recipient,
        recipient: offer.proposer,
        proposerAdvertisement: deepClone(offer.recipientAdvertisement),
        recipientAdvertisement: deepClone(offer.proposerAdvertisement),
        terms: deepClone(decision.counterTerms),
        createdAt: now,
        expiresAt: now + Math.min(offer.proposerAdvertisement.policy.proposalTtlMs, offer.recipientAdvertisement.policy.proposalTtlMs)
      };
      this.#s = {
        ...this.#s,
        status: "countered",
        currentOffer: nextOffer,
        transcript: [...this.#s.transcript, { round: nextRound, actor: nextOffer.proposer, action: "propose", terms: deepClone(nextOffer.terms), reason: "counterproposal", at: now }],
        updatedAt: now
      };
    }
    return this.snapshot();
  }

  #recordDecision(decision: NegotiationDecision, now: number): void {
    const offer = this.#s.currentOffer;
    this.#s = {
      ...this.#s,
      transcript: [...this.#s.transcript, { round: offer.round, actor: offer.recipient, action: decision.action, terms: deepClone(decision.counterTerms ?? offer.terms), reason: decision.reason, at: now }],
      updatedAt: now
    };
  }

  #finish(status: Exclude<NegotiationStatus, "proposed" | "countered" | "accepted">, reason: string, now: number): void {
    this.#s = { ...this.#s, status, rejectionReason: reason, updatedAt: now };
  }
}
