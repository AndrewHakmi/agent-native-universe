import type { DiscoveryAdvertisement, DiscoveryMatch } from "./types.js";
import { clamp01, intersect, jaccard, tokenize } from "./utils.js";

export function scoreAdvertisements(seeker: DiscoveryAdvertisement, peer: DiscoveryAdvertisement): DiscoveryMatch {
  const forwardMatches = intersect(seeker.accepts, peer.produces);
  const reverseMatches = intersect(peer.accepts, seeker.produces);
  const forwardCoverage = seeker.accepts.length === 0 ? 0 : forwardMatches.length / seeker.accepts.length;
  const reverseCoverage = peer.accepts.length === 0 ? 0 : reverseMatches.length / peer.accepts.length;
  const strongestDirection = Math.max(forwardCoverage, reverseCoverage);
  const mutualCoverage = (forwardCoverage + reverseCoverage) / 2;
  const reciprocity = (forwardMatches.length > 0 ? 0.5 : 0) + (reverseMatches.length > 0 ? 0.5 : 0);
  const objectiveAffinity = jaccard(
    tokenize(seeker.primaryObjective, ...seeker.secondaryObjectives),
    tokenize(peer.primaryObjective, ...peer.secondaryObjectives)
  );
  const needPriority = strongestNeedPriority(seeker, peer);
  const capacityFactor = peer.currentLinks >= peer.policy.maxLinks ? 0 : 1;
  const estimatedCommunicationCost = Math.max(0.01, (forwardMatches.length + reverseMatches.length) * 0.05);
  const costFitness = clamp01(1 - estimatedCommunicationCost / Math.max(0.01, seeker.policy.maxCommunicationCost));

  const score = clamp01(capacityFactor * (
    0.45 * strongestDirection
    + 0.15 * mutualCoverage
    + 0.15 * reciprocity
    + 0.10 * objectiveAffinity
    + 0.10 * needPriority
    + 0.05 * costFitness
  ));

  const reasons: string[] = [];
  if (forwardMatches.length) reasons.push(`peer produces required topics: ${forwardMatches.join(", ")}`);
  if (reverseMatches.length) reasons.push(`seeker reciprocates with: ${reverseMatches.join(", ")}`);
  if (objectiveAffinity > 0) reasons.push(`objective affinity=${objectiveAffinity.toFixed(3)}`);
  if (capacityFactor === 0) reasons.push("peer link capacity exhausted");

  return {
    seeker: seeker.agentId,
    peer: peer.agentId,
    score,
    forwardMatches,
    reverseMatches,
    objectiveAffinity,
    reciprocity,
    estimatedCommunicationCost,
    reasons
  };
}

function strongestNeedPriority(seeker: DiscoveryAdvertisement, peer: DiscoveryAdvertisement): number {
  let strongest = 0;
  for (const need of seeker.needs) {
    if (intersect(need.accepts, peer.produces).length > 0) strongest = Math.max(strongest, clamp01(need.priority));
  }
  return strongest;
}
