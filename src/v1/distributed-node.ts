import { randomUUID } from "node:crypto";
import {
  CryptoIdentity,
  IdentityRegistry,
  SecureTransport,
  TcpTransport,
  type JsonObject,
  type JsonValue,
  type NetworkAddress,
  type PublicIdentity,
  type SignedEnvelope,
} from "./security-transport.js";
import { PersistentGraphStore, type DurableCommand } from "./persistence-consensus.js";
import { ByzantineQuorum, type CommitCertificate } from "./consensus.js";
import { FractalUniverse, type FractalAgent, type FractalLink, type FractalProjection } from "./fractal-runtime.js";
import { LlmRouter, type ResourceKind } from "./economy-llm.js";

export type GraphOperation =
  | "agent.upsert"
  | "link.upsert"
  | "cluster.fold"
  | "cluster.unfold"
  | "resource.mint"
  | "resource.transfer";

export interface RuntimeJournalEntry {
  sequence: number;
  operation: GraphOperation;
  commandId: string;
  issuer: string;
  timestamp: number;
}

export interface DistributedRuntimeState {
  format: 1;
  sequence: number;
  appliedCommandIds: string[];
  graph: FractalProjection;
  balances: Record<string, Partial<Record<ResourceKind, number>>>;
  journal: RuntimeJournalEntry[];
}

export interface DistributedPeer {
  id: string;
  address: NetworkAddress;
  identity: PublicIdentity;
}

export interface DistributedNodeConfig {
  identity: CryptoIdentity;
  committee: PublicIdentity[];
  storageDirectory: string;
  listen?: NetworkAddress;
  peers?: DistributedPeer[];
  checkpointEvery?: number;
}

const EMPTY_STATE: DistributedRuntimeState = {
  format: 1,
  sequence: 0,
  appliedCommandIds: [],
  graph: { agents: [], links: [], metaAgents: [] },
  balances: {},
  journal: [],
};

export function createGraphCommand<T extends JsonObject>(issuer: string, type: GraphOperation, payload: T): DurableCommand<T> {
  return { id: randomUUID(), type, payload, issuedAt: Date.now(), issuer };
}

export function reduceRuntimeState(state: DistributedRuntimeState, command: DurableCommand): DistributedRuntimeState {
  if (state.appliedCommandIds.includes(command.id)) return structuredClone(state);
  const next = structuredClone(state);
  const operation = command.type as GraphOperation;
  switch (operation) {
    case "agent.upsert": {
      const agent = command.payload.agent as unknown as FractalAgent;
      const existing = next.graph.agents.findIndex((value) => value.id === agent.id);
      if (existing >= 0) next.graph.agents[existing] = structuredClone(agent);
      else next.graph.agents.push(structuredClone(agent));
      break;
    }
    case "link.upsert": {
      const link = command.payload.link as unknown as FractalLink;
      const existing = next.graph.links.findIndex((value) => value.id === link.id);
      if (existing >= 0) next.graph.links[existing] = structuredClone(link);
      else next.graph.links.push(structuredClone(link));
      break;
    }
    case "cluster.fold": {
      const universe = FractalUniverse.fromProjection(next.graph);
      universe.foldCluster(command.payload.members as unknown as string[], String(command.payload.metaAgentId ?? "") || undefined);
      next.graph = universe.projection();
      break;
    }
    case "cluster.unfold": {
      const universe = FractalUniverse.fromProjection(next.graph);
      universe.unfold(String(command.payload.metaAgentId));
      next.graph = universe.projection();
      break;
    }
    case "resource.mint": {
      const account = String(command.payload.account);
      const resource = String(command.payload.resource) as ResourceKind;
      const amount = positiveInteger(command.payload.amount);
      adjustBalance(next, account, resource, amount);
      break;
    }
    case "resource.transfer": {
      const debit = String(command.payload.debit);
      const credit = String(command.payload.credit);
      const resource = String(command.payload.resource) as ResourceKind;
      const amount = positiveInteger(command.payload.amount);
      if (balance(next, debit, resource) < amount) throw new Error(`${debit} has insufficient ${resource}`);
      adjustBalance(next, debit, resource, -amount);
      adjustBalance(next, credit, resource, amount);
      break;
    }
    default:
      throw new Error(`Unsupported replicated operation ${command.type}`);
  }
  next.sequence += 1;
  next.appliedCommandIds.push(command.id);
  next.journal.push({
    sequence: next.sequence,
    operation,
    commandId: command.id,
    issuer: command.issuer,
    timestamp: command.issuedAt,
  });
  return next;
}

function positiveInteger(value: JsonValue | undefined): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Resource amount must be a positive safe integer");
  return amount;
}

function balance(state: DistributedRuntimeState, account: string, resource: ResourceKind): number {
  return state.balances[account]?.[resource] ?? 0;
}

function adjustBalance(state: DistributedRuntimeState, account: string, resource: ResourceKind, delta: number): void {
  const values = state.balances[account] ?? {};
  const updated = (values[resource] ?? 0) + delta;
  if (updated < 0) throw new Error(`Negative ${resource} balance for ${account}`);
  values[resource] = updated;
  state.balances[account] = values;
}

export class DistributedGraphNode {
  readonly identity: CryptoIdentity;
  readonly committee: ByzantineQuorum;
  readonly registry = new IdentityRegistry();
  readonly tcp = new TcpTransport();
  readonly secure: SecureTransport;
  readonly store: PersistentGraphStore<DistributedRuntimeState & JsonValue>;
  readonly llmRouter = new LlmRouter();
  readonly #peers = new Map<string, DistributedPeer>();
  readonly #commitHandlers = new Set<(state: DistributedRuntimeState, certificate: CommitCertificate) => void | Promise<void>>();
  #state: DistributedRuntimeState = structuredClone(EMPTY_STATE);
  #started = false;
  #unsubscribe: (() => void) | undefined;
  #commitChain: Promise<void> = Promise.resolve();

  constructor(readonly config: DistributedNodeConfig) {
    this.identity = config.identity;
    this.committee = new ByzantineQuorum(config.committee);
    for (const member of config.committee) this.registry.register(member);
    this.registry.register(config.identity.publicIdentity());
    for (const peer of config.peers ?? []) this.addPeer(peer);
    this.secure = new SecureTransport(this.identity, this.registry, this.tcp);
    this.store = new PersistentGraphStore<DistributedRuntimeState & JsonValue>(config.storageDirectory);
  }

  get state(): DistributedRuntimeState {
    return structuredClone(this.#state);
  }

  get address(): NetworkAddress {
    return this.tcp.address;
  }

  addPeer(peer: DistributedPeer): void {
    if (peer.id === this.identity.id) return;
    this.registry.register(peer.identity);
    this.#peers.set(peer.id, { ...peer, address: { ...peer.address }, identity: { ...peer.identity } });
  }

  onCommit(handler: (state: DistributedRuntimeState, certificate: CommitCertificate) => void | Promise<void>): () => void {
    this.#commitHandlers.add(handler);
    return () => this.#commitHandlers.delete(handler);
  }

  async start(): Promise<NetworkAddress> {
    if (this.#started) return this.address;
    const recovered = await this.store.recover(
      structuredClone(EMPTY_STATE) as DistributedRuntimeState & JsonValue,
      (state, command) => reduceRuntimeState(state as DistributedRuntimeState, command) as DistributedRuntimeState & JsonValue,
    );
    this.#state = recovered.state as DistributedRuntimeState;
    const address = await this.tcp.start(this.config.listen ?? { host: "127.0.0.1", port: 0 });
    this.#unsubscribe = this.secure.onEnvelope((envelope) => this.#receive(envelope));
    this.#started = true;
    return address;
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.secure.close();
    await this.tcp.stop();
    this.#started = false;
  }

  async commit(certificate: CommitCertificate, options: { broadcast?: boolean } = {}): Promise<DistributedRuntimeState> {
    let result!: DistributedRuntimeState;
    const execute = async (): Promise<void> => {
      if (!this.committee.verifyCertificate(certificate)) throw new Error("Commit certificate is invalid or lacks a BFT quorum");
      const command = certificate.proposal.command;
      if (this.#state.appliedCommandIds.includes(command.id)) {
        result = this.state;
        return;
      }
      if (certificate.proposal.sequence !== this.#state.sequence + 1) {
        throw new Error(`Expected replicated sequence ${this.#state.sequence + 1}, got ${certificate.proposal.sequence}`);
      }
      await this.store.append(command);
      this.#state = reduceRuntimeState(this.#state, command);
      const checkpointEvery = this.config.checkpointEvery ?? 25;
      if (checkpointEvery > 0 && this.#state.sequence % checkpointEvery === 0) {
        await this.store.checkpoint(this.#state as DistributedRuntimeState & JsonValue);
      }
      if (options.broadcast !== false) await this.#broadcastCertificate(certificate);
      for (const handler of this.#commitHandlers) await handler(this.state, certificate);
      result = this.state;
    };
    const operation = this.#commitChain.then(execute, execute);
    this.#commitChain = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async checkpoint(): Promise<void> {
    await this.store.checkpoint(this.#state as DistributedRuntimeState & JsonValue);
  }

  buildCertificate<T extends JsonObject>(command: DurableCommand<T>, voters: CryptoIdentity[]): CommitCertificate<T> {
    const proposal = this.committee.proposal(this.identity, this.#state.sequence + 1, command);
    const votes = voters.map((identity) => this.committee.vote(identity, proposal));
    return this.committee.certify(proposal, votes);
  }

  async #broadcastCertificate(certificate: CommitCertificate): Promise<void> {
    const payload = certificate as unknown as JsonValue;
    await Promise.allSettled(
      [...this.#peers.values()].map((peer) => this.secure.send(peer.address, "graph.commit", payload, peer.id)),
    );
  }

  async #receive(envelope: SignedEnvelope): Promise<void> {
    if (envelope.topic !== "graph.commit") return;
    const certificate = envelope.payload as unknown as CommitCertificate;
    try {
      await this.commit(certificate, { broadcast: false });
    } catch {
      // Invalid, stale and out-of-order certificates are isolated to the receiving relationship.
    }
  }
}
