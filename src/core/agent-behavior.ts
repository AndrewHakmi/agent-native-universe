import type { LinkSnapshot } from "./link-protocol.js";
import type { NanoAgentSnapshot } from "./nano-agent.js";
import type { ConnectionOffer, DiscoveryAdvertisement, DiscoveryMatch, JsonObject, NegotiationDecision, ProtocolPatch } from "./types.js";

export type MaybePromise<T> = T | Promise<T>;

export interface CandidateContext {
  self: NanoAgentSnapshot;
  peer: DiscoveryAdvertisement;
  match: DiscoveryMatch;
}

export interface OfferContext {
  self: NanoAgentSnapshot;
  offer: ConnectionOffer;
}

export interface BoundaryContext {
  self: NanoAgentSnapshot;
  peer: NanoAgentSnapshot;
  link: LinkSnapshot;
}

export interface ProtocolReviewContext {
  self: NanoAgentSnapshot;
  peer: NanoAgentSnapshot;
  link: LinkSnapshot;
}

export interface NanoAgentBehavior {
  adjustCandidateScore?(context: CandidateContext): MaybePromise<number>;
  evaluateOffer?(context: OfferContext): MaybePromise<NegotiationDecision | null>;
  projectBoundaryState?(context: BoundaryContext): MaybePromise<JsonObject | null>;
  suggestProtocolPatch?(context: ProtocolReviewContext): MaybePromise<ProtocolPatch | null>;
}
