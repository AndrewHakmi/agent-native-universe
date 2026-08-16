import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { CryptoIdentity, canonicalJson, sha256, type JsonObject, type JsonValue, type PublicIdentity } from "./security-transport.js";
import { type DurableCommand } from "./persistence-consensus.js";

export interface ConsensusProposal<T extends JsonObject = JsonObject> {
  format: 1;
  committeeId: string;
  view: number;
  sequence: number;
  proposer: string;
  command: DurableCommand<T>;
  digest: string;
  signature: string;
}

export interface ConsensusVote {
  format: 1;
  committeeId: string;
  view: number;
  sequence: number;
  digest: string;
  voter: string;
  decision: "accept" | "reject";
  signature: string;
}

export interface CommitCertificate<T extends JsonObject = JsonObject> {
  proposal: ConsensusProposal<T>;
  votes: ConsensusVote[];
  quorum: number;
  certifiedAt: number;
}

export interface ViewChange {
  format: 1;
  committeeId: string;
  fromView: number;
  toView: number;
  voter: string;
  reason: string;
  signature: string;
}

type ProposalBody<T extends JsonObject> = Omit<ConsensusProposal<T>, "signature">;
type VoteBody = Omit<ConsensusVote, "signature">;
type ViewChangeBody = Omit<ViewChange, "signature">;

function verifySigned(publicKeyPem: string, body: JsonValue, signature: string): boolean {
  return cryptoVerify(
    null,
    Buffer.from(canonicalJson(body), "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(signature, "base64"),
  );
}

export class ByzantineQuorum {
  readonly #members = new Map<string, PublicIdentity>();
  readonly committeeId: string;
  view = 0;

  constructor(members: PublicIdentity[], committeeId?: string) {
    if (members.length < 4) throw new Error("BFT requires n >= 4 so at least one Byzantine replica is tolerated");
    for (const member of members) {
      if (this.#members.has(member.id)) throw new Error(`Duplicate BFT member ${member.id}`);
      this.#members.set(member.id, { ...member });
    }
    this.committeeId = committeeId ?? sha256(canonicalJson(members.map((member) => member.fingerprint).sort() as JsonValue));
  }

  get size(): number {
    return this.#members.size;
  }

  get f(): number {
    return Math.floor((this.size - 1) / 3);
  }

  get quorum(): number {
    return 2 * this.f + 1;
  }

  leader(view = this.view): string {
    return [...this.#members.keys()].sort()[view % this.size]!;
  }

  proposal<T extends JsonObject>(identity: CryptoIdentity, sequence: number, command: DurableCommand<T>): ConsensusProposal<T> {
    if (identity.id !== this.leader(this.view)) throw new Error(`${identity.id} is not the leader for view ${this.view}`);
    const body: ProposalBody<T> = {
      format: 1,
      committeeId: this.committeeId,
      view: this.view,
      sequence,
      proposer: identity.id,
      command,
      digest: sha256(canonicalJson(command as unknown as JsonValue)),
    };
    return { ...body, signature: identity.signValue(body as unknown as JsonValue) };
  }

  vote(identity: CryptoIdentity, proposal: ConsensusProposal, decision: "accept" | "reject" = "accept"): ConsensusVote {
    if (!this.#members.has(identity.id)) throw new Error(`${identity.id} is not a committee member`);
    if (!this.verifyProposal(proposal)) throw new Error("Cannot vote for an invalid proposal");
    const body: VoteBody = {
      format: 1,
      committeeId: this.committeeId,
      view: proposal.view,
      sequence: proposal.sequence,
      digest: proposal.digest,
      voter: identity.id,
      decision,
    };
    return { ...body, signature: identity.signValue(body as unknown as JsonValue) };
  }

  certify<T extends JsonObject>(proposal: ConsensusProposal<T>, votes: ConsensusVote[]): CommitCertificate<T> {
    if (!this.verifyProposal(proposal)) throw new Error("Invalid consensus proposal");
    const accepted = new Map<string, ConsensusVote>();
    for (const vote of votes) {
      if (vote.decision === "accept" && this.verifyVote(vote, proposal)) accepted.set(vote.voter, vote);
    }
    if (accepted.size < this.quorum) throw new Error(`BFT quorum not reached: ${accepted.size}/${this.quorum}`);
    return { proposal, votes: [...accepted.values()], quorum: this.quorum, certifiedAt: Date.now() };
  }

  verifyCertificate(certificate: CommitCertificate): boolean {
    if (!this.verifyProposal(certificate.proposal) || certificate.quorum !== this.quorum) return false;
    const voters = new Set<string>();
    for (const vote of certificate.votes) {
      if (vote.decision !== "accept" || voters.has(vote.voter) || !this.verifyVote(vote, certificate.proposal)) return false;
      voters.add(vote.voter);
    }
    return voters.size >= this.quorum;
  }

  viewChange(identity: CryptoIdentity, reason: string, toView = this.view + 1): ViewChange {
    if (!this.#members.has(identity.id) || toView <= this.view) throw new Error("Invalid view-change request");
    const body: ViewChangeBody = {
      format: 1,
      committeeId: this.committeeId,
      fromView: this.view,
      toView,
      voter: identity.id,
      reason,
    };
    return { ...body, signature: identity.signValue(body as unknown as JsonValue) };
  }

  advanceView(changes: ViewChange[]): number {
    const byTarget = new Map<number, Map<string, ViewChange>>();
    for (const change of changes) {
      if (!this.verifyViewChange(change)) continue;
      const votes = byTarget.get(change.toView) ?? new Map<string, ViewChange>();
      votes.set(change.voter, change);
      byTarget.set(change.toView, votes);
    }
    const next = [...byTarget.entries()]
      .filter(([, votes]) => votes.size >= this.quorum)
      .map(([view]) => view)
      .sort((a, b) => b - a)[0];
    if (next === undefined) throw new Error("View-change quorum not reached");
    this.view = next;
    return next;
  }

  verifyProposal(proposal: ConsensusProposal): boolean {
    const member = this.#members.get(proposal.proposer);
    if (!member || proposal.format !== 1 || proposal.committeeId !== this.committeeId) return false;
    if (proposal.proposer !== this.leader(proposal.view)) return false;
    if (proposal.digest !== sha256(canonicalJson(proposal.command as unknown as JsonValue))) return false;
    const { signature, ...body } = proposal;
    return verifySigned(member.publicKeyPem, body as unknown as JsonValue, signature);
  }

  verifyVote(vote: ConsensusVote, proposal: ConsensusProposal): boolean {
    const member = this.#members.get(vote.voter);
    if (!member || vote.format !== 1 || vote.committeeId !== this.committeeId) return false;
    if (vote.view !== proposal.view || vote.sequence !== proposal.sequence || vote.digest !== proposal.digest) return false;
    const { signature, ...body } = vote;
    return verifySigned(member.publicKeyPem, body as unknown as JsonValue, signature);
  }

  verifyViewChange(change: ViewChange): boolean {
    const member = this.#members.get(change.voter);
    if (!member || change.format !== 1 || change.committeeId !== this.committeeId || change.toView <= change.fromView) return false;
    const { signature, ...body } = change;
    return verifySigned(member.publicKeyPem, body as unknown as JsonValue, signature);
  }
}
