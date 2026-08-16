import { randomUUID } from "node:crypto";
import { DistributedDiscoveryMesh, type DistributedDiscoveryOptions } from "./distributed-discovery.js";
import { EncryptedTcpTransport } from "./encrypted-transport.js";
import { MeshIdentity } from "./identity.js";
import { NetworkByzantineNode, type NetworkByzantineOptions, type NetworkCommitCertificate } from "./network-consensus.js";
import { PersistentResourceEconomy } from "./persistent-market.js";
import { CognitiveScheduler, MeteredCognitiveLoop, type CognitiveBillingPolicy, type ScheduledMind, type ThoughtResult } from "./cognitive-loop.js";
import { ContinuousMetaAgentController, type ContinuousMetaAgentOptions } from "./metaagent-controller.js";
import type {
  AgentAdvertisement,
  AgentCognitivePort,
  ConsensusCommand,
  FractalGraphPort,
  JsonObject,
  MeshPeer,
  NetworkAddress,
  RemoteRelationship,
} from "./types.js";

export interface AutonomousMeshNodeConfig {
  identity: MeshIdentity;
  listen?: NetworkAddress;
  peers: MeshPeer[];
  committee: MeshPeer[];
  economyDirectory: string;
  discovery?: DistributedDiscoveryOptions;
  consensus?: NetworkByzantineOptions;
  llm?: {
    completion: ConstructorParameters<typeof MeteredCognitiveLoop>[1];
    billing: CognitiveBillingPolicy;
  };
  graph?: {
    port: FractalGraphPort;
    controller?: ContinuousMetaAgentOptions;
    replicateThroughConsensus?: boolean;
  };
  tickIntervalMs?: number;
  onConsensusCommit?: (certificate: NetworkCommitCertificate) => void | Promise<void>;
}

export interface RegisteredAutonomousAgent {
  agent: AgentCognitivePort;
  discovery?: {
    metadata?: JsonObject;
    profile?: Partial<AgentAdvertisement>;
  };
  mind?: Omit<ScheduledMind, "agent">;
}

export class AutonomousMeshNode {
  readonly identity: MeshIdentity;
  readonly transport: EncryptedTcpTransport;
  readonly discovery: DistributedDiscoveryMesh;
  readonly consensus: NetworkByzantineNode;
  readonly economy: PersistentResourceEconomy;
  readonly cognitiveLoop?: MeteredCognitiveLoop;
  readonly scheduler?: CognitiveScheduler;
  readonly metaagents?: ContinuousMetaAgentController;
  readonly #peers = new Map<string, MeshPeer>();
  #tickTimer: NodeJS.Timeout | undefined;
  #tickRunning = false;

  private constructor(readonly config: AutonomousMeshNodeConfig, economy: PersistentResourceEconomy) {
    this.identity = config.identity;
    this.transport = new EncryptedTcpTransport(config.identity);
    this.economy = economy;
    for (const peer of config.peers) {
      this.#peers.set(peer.identity.id, structuredClone(peer));
      this.transport.addPeer(peer.identity);
    }
    this.discovery = new DistributedDiscoveryMesh(config.identity.id, this.transport, config.discovery);
    for (const peer of config.peers) this.discovery.addPeer(peer);
    this.consensus = new NetworkByzantineNode(config.identity, this.transport, config.committee, {
      ...(config.consensus ?? {}),
      applyCommit: async (certificate) => {
        await this.#applyBuiltInCommit(certificate);
        await config.consensus?.applyCommit?.(certificate);
        await config.onConsensusCommit?.(certificate);
      },
    });
    if (config.llm) {
      this.cognitiveLoop = new MeteredCognitiveLoop(economy, config.llm.completion, config.llm.billing);
      this.scheduler = new CognitiveScheduler(this.cognitiveLoop);
    }
    if (config.graph) {
      const controller: ContinuousMetaAgentOptions = { ...(config.graph.controller ?? {}) };
      if (config.graph.replicateThroughConsensus) {
        controller.fold = async (members, requestedId) => {
          if (this.consensus.leader() !== this.identity.id) return null;
          await this.consensus.propose("cluster.fold", {
            members,
            metaAgentId: requestedId,
          });
          return config.graph?.port.getMetaAgent(requestedId) ?? null;
        };
        controller.unfold = async (metaAgentId) => {
          if (this.consensus.leader() !== this.identity.id) return null;
          const before = config.graph?.port.getMetaAgent(metaAgentId) ?? null;
          if (!before) return null;
          await this.consensus.propose("cluster.unfold", { metaAgentId });
          return before;
        };
      }
      this.metaagents = new ContinuousMetaAgentController(config.graph.port, controller);
    }
  }

  static async create(config: AutonomousMeshNodeConfig): Promise<AutonomousMeshNode> {
    return new AutonomousMeshNode(config, await PersistentResourceEconomy.open(config.economyDirectory));
  }

  get address(): NetworkAddress {
    return this.transport.address;
  }

  async start(): Promise<NetworkAddress> {
    const address = await this.transport.start(this.config.listen ?? { host: "127.0.0.1", port: 0 });
    this.discovery.start();
    this.consensus.start();
    this.scheduler?.start();
    this.metaagents?.start();
    const interval = Math.max(20, this.config.tickIntervalMs ?? 1_000);
    this.#tickTimer = setInterval(() => void this.tick().catch(() => undefined), interval);
    this.#tickTimer.unref?.();
    await this.discovery.announceAll();
    return address;
  }

  async stop(): Promise<void> {
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    this.#tickTimer = undefined;
    this.scheduler?.stop();
    this.metaagents?.stop();
    this.discovery.stop();
    this.consensus.stop();
    await this.economy.checkpoint();
    await this.transport.stop();
  }

  registerAgent(registration: RegisteredAutonomousAgent): void {
    this.discovery.registerAgent(registration.agent, registration.discovery);
    if (registration.mind) {
      if (!this.scheduler) throw new Error("Cannot register an LLM mind without an LLM completion provider");
      this.scheduler.register({ agent: registration.agent, ...registration.mind });
    }
  }

  unregisterAgent(agentId: string): void {
    this.discovery.unregisterAgent(agentId);
    this.scheduler?.unregister(agentId);
  }

  async think(agentId: string): Promise<ThoughtResult> {
    if (!this.scheduler) throw new Error("This autonomous node has no cognitive scheduler");
    return this.scheduler.runOnce(agentId);
  }

  async propose(type: string, payload: JsonObject): Promise<NetworkCommitCertificate> {
    return this.consensus.propose(type, payload);
  }

  async tick(now = Date.now()): Promise<{
    createdRelationships: RemoteRelationship[];
    synchronizedRelationships: RemoteRelationship[];
  }> {
    if (this.#tickRunning) return { createdRelationships: [], synchronizedRelationships: [] };
    this.#tickRunning = true;
    try {
      const discovery = await this.discovery.tick(now);
      await this.metaagents?.tick();
      await this.economy.expire(now);
      return {
        createdRelationships: discovery.created,
        synchronizedRelationships: discovery.synchronized,
      };
    } finally {
      this.#tickRunning = false;
    }
  }

  async requestViewChange(reason: string): Promise<number> {
    return this.consensus.requestViewChange(reason);
  }

  peer(id: string): MeshPeer | undefined {
    const peer = this.#peers.get(id);
    return peer ? structuredClone(peer) : undefined;
  }


  async #applyBuiltInCommit(certificate: NetworkCommitCertificate): Promise<void> {
    const graph = this.config.graph?.port;
    if (!graph) return;
    const command = certificate.proposal.command;
    if (command.type === "cluster.fold") {
      const members = command.payload.members;
      const metaAgentId = String(command.payload.metaAgentId ?? "");
      if (!Array.isArray(members) || members.some((member) => typeof member !== "string") || !metaAgentId) {
        throw new Error("Invalid replicated cluster.fold command");
      }
      if (!graph.getMetaAgent(metaAgentId)) graph.foldCluster(members as string[], metaAgentId);
      return;
    }
    if (command.type === "cluster.unfold") {
      const metaAgentId = String(command.payload.metaAgentId ?? "");
      if (!metaAgentId) throw new Error("Invalid replicated cluster.unfold command");
      if (graph.getMetaAgent(metaAgentId)) graph.unfold(metaAgentId);
    }
  }

  static command(type: string, payload: JsonObject, issuer: string): ConsensusCommand {
    return {
      id: randomUUID(),
      type,
      payload: structuredClone(payload),
      issuer,
      issuedAt: Date.now(),
    };
  }
}
