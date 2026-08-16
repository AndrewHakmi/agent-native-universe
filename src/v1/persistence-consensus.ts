import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CryptoIdentity,
  IdentityRegistry,
  canonicalJson,
  sha256,
  type JsonObject,
  type JsonValue,
  type PublicIdentity,
} from "./security-transport.js";

export interface DurableCommand<T extends JsonObject = JsonObject> {
  id: string;
  type: string;
  payload: T;
  issuedAt: number;
  issuer: string;
}

export interface WalRecord<T extends JsonObject = JsonObject> {
  sequence: number;
  previousHash: string;
  command: DurableCommand<T>;
  hash: string;
}

export interface GraphSnapshot<S extends JsonValue> {
  format: 1;
  sequence: number;
  lastHash: string;
  state: S;
  writtenAt: number;
  checksum: string;
}

function recordHash(record: Omit<WalRecord, "hash">): string {
  return sha256(canonicalJson(record as unknown as JsonValue));
}

function snapshotChecksum<S extends JsonValue>(snapshot: Omit<GraphSnapshot<S>, "checksum">): string {
  return sha256(canonicalJson(snapshot as unknown as JsonValue));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class PersistentGraphStore<S extends JsonValue> {
  readonly #walPath: string;
  readonly #snapshotPath: string;
  #sequence = 0;
  #lastHash = "GENESIS";

  constructor(readonly directory: string) {
    this.#walPath = join(directory, "graph.wal.jsonl");
    this.#snapshotPath = join(directory, "graph.snapshot.json");
  }

  get sequence(): number {
    return this.#sequence;
  }

  get lastHash(): string {
    return this.#lastHash;
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    if (!(await exists(this.#walPath))) await writeFile(this.#walPath, "", "utf8");
  }

  async append<T extends JsonObject>(command: DurableCommand<T>): Promise<WalRecord<T>> {
    await this.initialize();
    const unsigned: Omit<WalRecord<T>, "hash"> = {
      sequence: this.#sequence + 1,
      previousHash: this.#lastHash,
      command,
    };
    const record: WalRecord<T> = { ...unsigned, hash: recordHash(unsigned as Omit<WalRecord, "hash">) };
    const handle = await open(this.#walPath, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#sequence = record.sequence;
    this.#lastHash = record.hash;
    return record;
  }

  async checkpoint(state: S): Promise<GraphSnapshot<S>> {
    await this.initialize();
    const unsigned: Omit<GraphSnapshot<S>, "checksum"> = {
      format: 1,
      sequence: this.#sequence,
      lastHash: this.#lastHash,
      state,
      writtenAt: Date.now(),
    };
    const snapshot: GraphSnapshot<S> = { ...unsigned, checksum: snapshotChecksum(unsigned) };
    const temporary = `${this.#snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#snapshotPath);
    return snapshot;
  }

  async recover(
    initialState: S,
    reduce: (state: S, command: DurableCommand) => S,
  ): Promise<{ state: S; sequence: number; lastHash: string; replayed: number }> {
    await this.initialize();
    let state = initialState;
    let snapshotSequence = 0;
    let snapshotHash = "GENESIS";
    if (await exists(this.#snapshotPath)) {
      const snapshot = JSON.parse(await readFile(this.#snapshotPath, "utf8")) as GraphSnapshot<S>;
      const { checksum, ...unsigned } = snapshot;
      if (snapshot.format !== 1 || checksum !== snapshotChecksum(unsigned)) throw new Error("Persistent graph snapshot checksum mismatch");
      state = snapshot.state;
      snapshotSequence = snapshot.sequence;
      snapshotHash = snapshot.lastHash;
    }

    const text = await readFile(this.#walPath, "utf8");
    const records = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as WalRecord);
    let previousHash = "GENESIS";
    let previousSequence = 0;
    let replayed = 0;
    for (const record of records) {
      const { hash, ...unsigned } = record;
      if (record.sequence !== previousSequence + 1) throw new Error(`WAL sequence gap at ${record.sequence}`);
      if (record.previousHash !== previousHash) throw new Error(`WAL hash-chain break at ${record.sequence}`);
      if (recordHash(unsigned) !== hash) throw new Error(`WAL checksum mismatch at ${record.sequence}`);
      previousHash = hash;
      previousSequence = record.sequence;
      if (record.sequence > snapshotSequence) {
        state = reduce(state, record.command);
        replayed += 1;
      }
    }
    if (snapshotSequence > previousSequence) throw new Error("Snapshot is ahead of the durable WAL");
    if (snapshotSequence > 0) {
      const anchor = records.find((record) => record.sequence === snapshotSequence);
      if (!anchor || anchor.hash !== snapshotHash) throw new Error("Snapshot does not match the WAL hash chain");
    }
    this.#sequence = previousSequence;
    this.#lastHash = previousHash;
    return { state, sequence: previousSequence, lastHash: previousHash, replayed };
  }
}

export interface CommitteeMember extends PublicIdentity {
  weight?: number;
}

export interface BftProposal<T extends JsonObject = JsonObject> {
  format: 1;
  committeeId: string;
  view: number;
  sequence: number;
  proposer: string;
  command: DurableCommand<T>;
  digest: string;
  signature: string;
}

export interface BftVote {
  format: 1;
  committeeId: string;
  view: number;
  sequence: number;
  proposalDigest: string;
  voter: string;
  decision: "accept" | "reject";
  signature: string;
}

export interface BftCertificate<T extends JsonObject = JsonObject> {
  proposal: BftProposal<T>;
  votes: BftVote[];
  quorum: number;
  certifiedAt: number;
}

export interface ViewChangeVote {
  format: 1;
  committeeId: string;
  fromView: number;
  toView: number;
  voter: string;
  reason: string;
  signature: string;
}

function proposalUnsigned<T extends JsonObject>(proposal: Omit<BftProposal<T>, "signature">): JsonValue {
  return proposal as unknown as JsonValue;
}

function voteUnsigned(vote: Omit<BftVote, "signature">): JsonValue {
  return vote as unknown as JsonValue;
}

function viewChangeUnsigned(vote: Omit<ViewChangeVote, "signature">): JsonValue {
  return vote as unknown as JsonValue;
}

export class ByzantineCommittee {
  readonly #members = new Map<string, CommitteeMember>();
  readonly #registry = new IdentityRegistry();
  readonly committeeId: string;
  view = 0;

  constructor(members: CommitteeMember[], committeeId?: string) {
    if (members.length < 4) throw new Error("A Byzantine committee requires at least four replicas");
    for (const member of members) {
      if (this.#members.has(member.id)) throw new Error(`Duplicate committee member ${member.id}`);
      this.#members.set(member.id, { ...member });
      this.#registry.register(member);
    }
    this.committeeId = committeeId ?? sha256(canonicalJson(members.map((member) => member.fingerprint).sort() as JsonValue));
  }

  get size(): number {
    return this.#members.size;
  }

  get maxByzantineFaults(): number {
    return Math.floor((this.size - 1) / 3);
  }

  get quorum(): number {
    return 2 * this.maxByzantineFaults + 1;
  }

  leader(view = this.view): string {
    return [...this.#members.keys()].sort()[view % this.size]!;
  }

  createProposal<T extends JsonObject>(identity: CryptoIdentity, sequence: number, command: DurableCommand<T>): BftProposal<T> {
    if (identity.id !== this.leader()) throw new Error(`${identity.id} is not leader for view ${this.view}`);
    const base = {
      format: 1 as const,
      committeeId: this.committeeId,
      view: this.view,
      sequence,
      proposer: identity.id,
      command,
      digest: sha256(canonicalJson(command as unknown as JsonValue)),
    };
    return { ...base, signature: identity.signValue(proposalUnsigned({ ...base, signature: undefined } as never)) };
  }

  createVote(identity: CryptoIdentity, proposal: BftProposal, decision: "accept" | "reject" = "accept"): BftVote {
    if (!this.#members.has(identity.id)) throw new Error(`${identity.id} is not a committee member`);
    if (!this.verifyProposal(proposal)) throw new Error("Cannot vote for an invalid proposal");
    const base = {
      format: 1 as const,
      committeeId: this.committeeId,
      view: proposal.view,
      sequence: proposal.sequence,
      proposalDigest: proposal.digest,
      voter: identity.id,
      decision,
    };
    return { ...base, signature: identity.signValue(voteUnsigned({ ...base, signature: undefined } as never)) };
  }

  certify<T extends JsonObject>(proposal: BftProposal<T>, votes: BftVote[]): BftCertificate<T> {
    if (!this.verifyProposal(proposal)) throw new Error("Invalid BFT proposal");
    const unique = new Map<string, BftVote>();
    for (const vote of votes) {
      if (vote.decision !== "accept" || !this.verifyVote(vote, proposal)) continue;
      unique.set(vote.voter, vote);
    }
    if (unique.size < this.quorum) throw new Error(`BFT quorum not reached: ${unique.size}/${this.quorum}`);
    return { proposal, votes: [...unique.values()], quorum: this.quorum, certifiedAt: Date.now() };
  }

  verifyCertificate(certificate: BftCertificate): boolean {
    if (!this.verifyProposal(certificate.proposal) || certificate.quorum !== this.quorum) return false;
    const voters = new Set<string>();
    for (const vote of certificate.votes) {
      if (vote.decision !== "accept" || voters.has(vote.voter) || !this.verifyVote(vote, certificate.proposal)) return false;
      voters.add(vote.voter);
    }
    return voters.size >= this.quorum;
  }

  createViewChange(identity: CryptoIdentity, reason: string, toView = this.view + 1): ViewChangeVote {
    if (!this.#members.has(identity.id) || toView <= this.view) throw new Error("Invalid view-change voter or target");
    const base = {
      format: 1 as const,
      committeeId: this.committeeId,
      fromView: this.view,
      toView,
      voter: identity.id,
      reason,
    };
    return { ...base, signature: identity.signValue(viewChangeUnsigned({ ...base, signature: undefined } as never)) };
  }

  applyViewChange(votes: ViewChangeVote[]): number {
    const groups = new Map<number, Map<string, ViewChangeVote>>();
    for (const vote of votes) {
      if (!this.verifyViewChange(vote)) continue;
      const group = groups.get(vote.toView) ?? new Map<string, ViewChangeVote>();
      group.set(vote.voter, vote);
      groups.set(vote.toView, group);
    }
    const winning = [...groups.entries()]
      .filter(([, group]) => group.size >= this.quorum)
      .map(([view]) => view)
      .sort((a, b) => b - a)[0];
    if (winning === undefined) throw new Error("View-change quorum not reached");
    this.view = winning;
    return winning;
  }

  verifyProposal(proposal: BftProposal): boolean {
    const member = this.#members.get(proposal.proposer);
    if (!member || proposal.format !== 1 || proposal.committeeId !== this.committeeId) return false;
    if (proposal.proposer !== this.leader(proposal.view)) return false;
    if (proposal.digest !== sha256(canonicalJson(proposal.command as unknown as JsonValue))) return false;
    const { signature, ...unsigned } = proposal;
    return verifyDetached(member.publicKeyPem, proposalUnsigned(unsigned), signature);
  }

  verifyVote(vote: BftVote, proposal: BftProposal): boolean {
    const member = this.#members.get(vote.voter);
    if (!member || vote.format !== 1 || vote.committeeId !== this.committeeId) return false;
    if (vote.view !== proposal.view || vote.sequence !== proposal.sequence || vote.proposalDigest !== proposal.digest) return false;
    const { signature, ...unsigned } = vote;
    return verifyDetached(member.publicKeyPem, voteUnsigned(unsigned), signature);
  }

  verifyViewChange(vote: ViewChangeVote): boolean {
    const member = this.#members.get(vote.voter);
    if (!member || vote.format !== 1 || vote.committeeId !== this.committeeId || vote.toView <= vote.fromView) return false;
    const { signature, ...unsigned } = vote;
    return verifyDetached(member.publicKeyPem, viewChangeUnsigned(unsigned), signature);
  }
}

function verifyDetached(publicKeyPem: string, value: JsonValue, signature: string): boolean {
  const { verify, createPublicKey } = require("node:crypto") as typeof import("node:crypto");
  return verify(null, Buffer.from(canonicalJson(value), "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
}
