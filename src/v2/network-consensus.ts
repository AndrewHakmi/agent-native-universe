import { randomUUID } from "node:crypto";
import { EncryptedTcpTransport, type DecryptedMeshMessage } from "./encrypted-transport.js";
import { canonicalJson, MeshIdentity, sha256, verifyMeshSignature } from "./identity.js";
import type { ConsensusCommand, JsonObject, JsonValue, MeshPeer, MeshPublicIdentity } from "./types.js";

export interface NetworkProposal {
  format: 2;
  committeeId: string;
  view: number;
  sequence: number;
  proposer: string;
  command: ConsensusCommand;
  digest: string;
  signature: string;
}

export interface NetworkVote {
  format: 2;
  committeeId: string;
  view: number;
  sequence: number;
  proposalDigest: string;
  voter: string;
  decision: "accept" | "reject";
  reason: string;
  signature: string;
}

export interface NetworkCommitCertificate {
  format: 2;
  proposal: NetworkProposal;
  votes: NetworkVote[];
  quorum: number;
  certifiedAt: number;
}

export interface NetworkViewChange {
  format: 2;
  committeeId: string;
  fromView: number;
  toView: number;
  voter: string;
  reason: string;
  signature: string;
}

interface PendingRound {
  proposal: NetworkProposal;
  votes: Map<string, NetworkVote>;
  resolve: (certificate: NetworkCommitCertificate) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface NetworkByzantineOptions {
  voteTimeoutMs?: number;
  validateCommand?: (command: ConsensusCommand) => boolean | Promise<boolean>;
  applyCommit?: (certificate: NetworkCommitCertificate) => void | Promise<void>;
}

export class NetworkByzantineNode {
  readonly committeeId: string;
  readonly #members = new Map<string, MeshPublicIdentity>();
  readonly #peers = new Map<string, MeshPeer>();
  readonly #pending = new Map<string, PendingRound>();
  readonly #viewVotes = new Map<number, Map<string, NetworkViewChange>>();
  readonly #committed = new Set<string>();
  #unsubscribe: (() => void) | undefined;
  #view = 0;
  #sequence = 0;

  constructor(
    readonly identity: MeshIdentity,
    readonly transport: EncryptedTcpTransport,
    committee: MeshPeer[],
    readonly options: NetworkByzantineOptions = {},
  ) {
    for (const peer of committee) {
      if (this.#members.has(peer.identity.id)) throw new Error(`Duplicate committee member ${peer.identity.id}`);
      this.#members.set(peer.identity.id, structuredClone(peer.identity));
      this.#peers.set(peer.identity.id, structuredClone(peer));
      this.transport.addPeer(peer.identity);
    }
    if (!this.#members.has(identity.id)) throw new Error(`Local identity ${identity.id} is absent from the BFT committee`);
    if (this.#members.size < 4) throw new Error("Network BFT requires at least four committee members");
    this.committeeId = sha256(canonicalJson(
      [...this.#members.values()].map((member) => `${member.id}:${member.signingFingerprint}:${member.encryptionFingerprint}`).sort() as unknown as JsonValue,
    ));
  }

  get view(): number {
    return this.#view;
  }

  get sequence(): number {
    return this.#sequence;
  }

  get f(): number {
    return Math.floor((this.#members.size - 1) / 3);
  }

  get quorum(): number {
    return 2 * this.f + 1;
  }

  leader(view = this.#view): string {
    return [...this.#members.keys()].sort()[view % this.#members.size]!;
  }

  restore(sequence: number, view = 0): void {
    if (!Number.isSafeInteger(sequence) || sequence < this.#sequence) throw new Error("Cannot restore BFT sequence backwards");
    if (!Number.isSafeInteger(view) || view < this.#view) throw new Error("Cannot restore BFT view backwards");
    this.#sequence = sequence;
    this.#view = view;
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.transport.onMessage((message) => this.#receive(message));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Network BFT node stopped"));
    }
    this.#pending.clear();
  }

  async propose(type: string, payload: JsonObject): Promise<NetworkCommitCertificate> {
    if (this.identity.id !== this.leader()) throw new Error(`${this.identity.id} is not leader for view ${this.#view}`);
    const command: ConsensusCommand = {
      id: randomUUID(),
      type,
      payload: structuredClone(payload),
      issuer: this.identity.id,
      issuedAt: Date.now(),
    };
    const proposal = this.#createProposal(command);
    const key = proposal.digest;
    const certificatePromise = new Promise<NetworkCommitCertificate>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new Error(`Network BFT quorum timed out for proposal ${proposal.digest}`));
      }, this.options.voteTimeoutMs ?? 5_000);
      this.#pending.set(key, { proposal, votes: new Map(), resolve, reject, timer });
    });

    const ownDecision = await this.#validate(proposal.command);
    const ownVote = this.#createVote(proposal, ownDecision, ownDecision ? "locally accepted" : "local validation rejected");
    this.#recordVote(ownVote);

    await Promise.allSettled(
      [...this.#peers.values()]
        .filter((peer) => peer.identity.id !== this.identity.id)
        .map((peer) => this.transport.send(peer, "bft.proposal", proposal as unknown as JsonValue)),
    );
    return certificatePromise;
  }

  async requestViewChange(reason: string, toView = this.#view + 1): Promise<number> {
    const vote = this.#createViewChange(reason, toView);
    this.#recordViewChange(vote);
    await Promise.allSettled(
      [...this.#peers.values()]
        .filter((peer) => peer.identity.id !== this.identity.id)
        .map((peer) => this.transport.send(peer, "bft.view-change", vote as unknown as JsonValue)),
    );
    return this.#view;
  }

  verifyCertificate(certificate: NetworkCommitCertificate): boolean {
    if (certificate.format !== 2 || certificate.quorum !== this.quorum) return false;
    if (!this.#verifyProposal(certificate.proposal)) return false;
    const voters = new Set<string>();
    for (const vote of certificate.votes) {
      if (vote.decision !== "accept" || voters.has(vote.voter) || !this.#verifyVote(vote, certificate.proposal)) return false;
      voters.add(vote.voter);
    }
    return voters.size >= this.quorum;
  }

  async #receive(message: DecryptedMeshMessage): Promise<void> {
    switch (message.topic) {
      case "bft.proposal":
        await this.#handleProposal(message.payload as unknown as NetworkProposal);
        return;
      case "bft.vote":
        this.#recordVote(message.payload as unknown as NetworkVote);
        return;
      case "bft.commit":
        await this.#applyCertificate(message.payload as unknown as NetworkCommitCertificate);
        return;
      case "bft.view-change":
        await this.#handleViewChange(message.payload as unknown as NetworkViewChange);
        return;
      default:
        return;
    }
  }

  async #handleProposal(proposal: NetworkProposal): Promise<void> {
    if (!this.#verifyProposal(proposal)) return;
    if (proposal.sequence !== this.#sequence + 1 || proposal.view !== this.#view) return;
    const accepted = await this.#validate(proposal.command);
    const vote = this.#createVote(proposal, accepted, accepted ? "validated" : "command rejected by local policy");
    const leaderPeer = this.#peers.get(proposal.proposer);
    if (!leaderPeer) return;
    await this.transport.send(leaderPeer, "bft.vote", vote as unknown as JsonValue);
  }

  #recordVote(vote: NetworkVote): void {
    const pending = this.#pending.get(vote.proposalDigest);
    if (!pending || !this.#verifyVote(vote, pending.proposal)) return;
    pending.votes.set(vote.voter, vote);
    const accepted = [...pending.votes.values()].filter((candidate) => candidate.decision === "accept");
    if (accepted.length < this.quorum) return;
    clearTimeout(pending.timer);
    this.#pending.delete(vote.proposalDigest);
    const certificate: NetworkCommitCertificate = {
      format: 2,
      proposal: pending.proposal,
      votes: accepted,
      quorum: this.quorum,
      certifiedAt: Date.now(),
    };
    void this.#applyAndBroadcast(certificate).then(() => pending.resolve(certificate), pending.reject);
  }

  async #applyAndBroadcast(certificate: NetworkCommitCertificate): Promise<void> {
    await this.#applyCertificate(certificate);
    await Promise.allSettled(
      [...this.#peers.values()]
        .filter((peer) => peer.identity.id !== this.identity.id)
        .map((peer) => this.transport.send(peer, "bft.commit", certificate as unknown as JsonValue)),
    );
  }

  async #applyCertificate(certificate: NetworkCommitCertificate): Promise<void> {
    if (!this.verifyCertificate(certificate)) throw new Error("Invalid network BFT certificate");
    const commandId = certificate.proposal.command.id;
    if (this.#committed.has(commandId)) return;
    if (certificate.proposal.sequence !== this.#sequence + 1) {
      throw new Error(`Expected BFT sequence ${this.#sequence + 1}, got ${certificate.proposal.sequence}`);
    }
    this.#committed.add(commandId);
    this.#sequence = certificate.proposal.sequence;
    await this.options.applyCommit?.(certificate);
  }

  async #handleViewChange(vote: NetworkViewChange): Promise<void> {
    if (!this.#verifyViewChange(vote)) return;
    this.#recordViewChange(vote);
    if (vote.voter !== this.identity.id) {
      const local = this.#createViewChange(vote.reason, vote.toView);
      this.#recordViewChange(local);
      const peers = [...this.#peers.values()].filter((peer) => peer.identity.id !== this.identity.id);
      await Promise.allSettled(peers.map((peer) => this.transport.send(peer, "bft.view-change", local as unknown as JsonValue)));
    }
  }

  #recordViewChange(vote: NetworkViewChange): void {
    if (!this.#verifyViewChange(vote)) return;
    const group = this.#viewVotes.get(vote.toView) ?? new Map<string, NetworkViewChange>();
    group.set(vote.voter, vote);
    this.#viewVotes.set(vote.toView, group);
    if (group.size >= this.quorum && vote.toView > this.#view) {
      this.#view = vote.toView;
      for (const [target] of this.#viewVotes) if (target <= this.#view) this.#viewVotes.delete(target);
    }
  }

  #createProposal(command: ConsensusCommand): NetworkProposal {
    const body = {
      format: 2 as const,
      committeeId: this.committeeId,
      view: this.#view,
      sequence: this.#sequence + 1,
      proposer: this.identity.id,
      command,
      digest: sha256(canonicalJson(command as unknown as JsonValue)),
    };
    return { ...body, signature: this.identity.sign(body as unknown as JsonValue) };
  }

  #createVote(proposal: NetworkProposal, accepted: boolean, reason: string): NetworkVote {
    const body = {
      format: 2 as const,
      committeeId: this.committeeId,
      view: proposal.view,
      sequence: proposal.sequence,
      proposalDigest: proposal.digest,
      voter: this.identity.id,
      decision: accepted ? "accept" as const : "reject" as const,
      reason,
    };
    return { ...body, signature: this.identity.sign(body as unknown as JsonValue) };
  }

  #createViewChange(reason: string, toView: number): NetworkViewChange {
    if (toView <= this.#view) throw new Error("View-change target must advance the view");
    const body = {
      format: 2 as const,
      committeeId: this.committeeId,
      fromView: this.#view,
      toView,
      voter: this.identity.id,
      reason,
    };
    return { ...body, signature: this.identity.sign(body as unknown as JsonValue) };
  }

  #verifyProposal(proposal: NetworkProposal): boolean {
    const member = this.#members.get(proposal.proposer);
    if (!member || proposal.format !== 2 || proposal.committeeId !== this.committeeId) return false;
    if (proposal.proposer !== this.leader(proposal.view)) return false;
    if (proposal.digest !== sha256(canonicalJson(proposal.command as unknown as JsonValue))) return false;
    const { signature, ...body } = proposal;
    return verifyMeshSignature(member, body as unknown as JsonValue, signature);
  }

  #verifyVote(vote: NetworkVote, proposal: NetworkProposal): boolean {
    const member = this.#members.get(vote.voter);
    if (!member || vote.format !== 2 || vote.committeeId !== this.committeeId) return false;
    if (vote.view !== proposal.view || vote.sequence !== proposal.sequence || vote.proposalDigest !== proposal.digest) return false;
    const { signature, ...body } = vote;
    return verifyMeshSignature(member, body as unknown as JsonValue, signature);
  }

  #verifyViewChange(vote: NetworkViewChange): boolean {
    const member = this.#members.get(vote.voter);
    if (!member || vote.format !== 2 || vote.committeeId !== this.committeeId) return false;
    if (vote.toView <= vote.fromView || vote.toView <= this.#view) return false;
    const { signature, ...body } = vote;
    return verifyMeshSignature(member, body as unknown as JsonValue, signature);
  }

  async #validate(command: ConsensusCommand): Promise<boolean> {
    try {
      return this.options.validateCommand ? await this.options.validateCommand(command) : true;
    } catch {
      return false;
    }
  }
}
