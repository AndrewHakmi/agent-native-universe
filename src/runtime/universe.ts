import { Constitution } from "../core/constitution.js";
import { NotFoundError, ProtocolViolation } from "../core/errors.js";
import { LinkProtocol, type LinkProtocolSpec, type LinkSnapshot } from "../core/link-protocol.js";
import { NanoAgent, type NanoAgentSnapshot, type NanoAgentSpec } from "../core/nano-agent.js";
import type { AgentId, EvolutionOptions, EvolutionReport, LinkId, ObjectiveVector } from "../core/types.js";
import { TopologyRuntime } from "./topology-runtime.js";

export interface UniverseOptions {
  constitution?: Constitution;
}

export interface UniverseSnapshot {
  agents: NanoAgentSnapshot[];
  links: LinkSnapshot[];
  retiredLinks: LinkSnapshot[];
}

/**
 * In-memory host for the two primitives. Universe owns storage and hard graph
 * integrity only; autonomous peer selection and topology evolution live in
 * TopologyRuntime and in each NanoAgent's local policy/behavior.
 */
export class Universe {
  readonly agents = new Map<AgentId, NanoAgent>();
  readonly links = new Map<LinkId, LinkProtocol>();
  readonly retiredLinks = new Map<LinkId, LinkSnapshot>();
  readonly topology: TopologyRuntime;

  #constitution: Constitution | undefined;

  constructor(options: UniverseOptions = {}) {
    this.#constitution = options.constitution;
    this.topology = new TopologyRuntime(this);
  }

  createAgent(spec: NanoAgentSpec): NanoAgent {
    const agent = new NanoAgent(spec);
    if (this.agents.has(agent.id)) throw new ProtocolViolation(`agent ${agent.id} already exists`);
    this.agents.set(agent.id, agent);
    this.topology.recordAgentCreated(agent.id);
    return agent;
  }

  /** Manual connection is retained as an escape hatch and deterministic test primitive. */
  connect(spec: LinkProtocolSpec): LinkProtocol {
    this.requireAgent(spec.left);
    this.requireAgent(spec.right);
    const link = new LinkProtocol({ ...spec, lifecycle: spec.lifecycle ?? "active" });
    this.attachLink(link);
    return link;
  }

  /** Called after a pairwise protocol has been accepted. */
  attachLink(link: LinkProtocol): void {
    const snapshot = link.snapshot();
    const left = this.requireAgent(snapshot.left);
    const right = this.requireAgent(snapshot.right);
    if (this.links.has(link.id)) throw new ProtocolViolation(`link ${link.id} already exists`);
    const existing = this.findLinkBetween(snapshot.left, snapshot.right);
    if (existing) throw new ProtocolViolation(`relationship already exists as ${existing.id}`);

    this.#authorize(snapshot.left, "link.create", snapshot.right);
    this.#authorize(snapshot.right, "link.accept", snapshot.left);
    this.links.set(link.id, link);
    left.addLink(link.id);
    right.addLink(link.id);
  }

  disconnect(id: LinkId, now = Date.now()): void {
    const link = this.requireLink(id);
    if (link.snapshot().lifecycle !== "retired") link.retire(now);
    this.removeLink(id);
  }

  /** Detaches a link without imposing another lifecycle transition. */
  removeLink(id: LinkId): void {
    const link = this.links.get(id);
    if (!link) return;
    const snapshot = link.snapshot();
    this.agents.get(snapshot.left)?.removeLink(id);
    this.agents.get(snapshot.right)?.removeLink(id);
    this.links.delete(id);
    if (snapshot.lifecycle === "retired") this.retiredLinks.set(id, snapshot);
  }

  findLinkBetween(left: AgentId, right: AgentId): LinkProtocol | undefined {
    for (const link of this.links.values()) {
      const snapshot = link.snapshot();
      if ((snapshot.left === left && snapshot.right === right) || (snapshot.left === right && snapshot.right === left)) return link;
    }
    return undefined;
  }

  evolve(options: EvolutionOptions = {}): Promise<EvolutionReport> {
    return this.topology.evolve(options);
  }

  cloneAgent(id: AgentId, overrides: Partial<NanoAgentSpec> = {}): NanoAgent {
    const clone = this.requireAgent(id).clone(overrides);
    this.agents.set(clone.id, clone);
    this.topology.recordAgentCreated(clone.id);
    return clone;
  }

  splitAgent(id: AgentId, objectives: ObjectiveVector[]): NanoAgent[] {
    const parent = this.requireAgent(id);
    const children = parent.split(objectives);
    for (const child of children) {
      this.agents.set(child.id, child);
      this.topology.recordAgentCreated(child.id);
    }
    parent.sleep();
    return children;
  }

  mergeAgents(aId: AgentId, bId: AgentId, objective: ObjectiveVector): NanoAgent {
    const a = this.requireAgent(aId);
    const b = this.requireAgent(bId);
    const merged = NanoAgent.merge(a, b, objective);
    this.agents.set(merged.id, merged);
    this.topology.recordAgentCreated(merged.id);
    a.sleep();
    b.sleep();
    return merged;
  }

  tick(now = Date.now()): void {
    for (const link of [...this.links.values()]) {
      link.decay(now);
      link.reviewLifecycle(now);
      if (link.snapshot().lifecycle === "retired") this.removeLink(link.id);
    }
    for (const agent of this.agents.values()) {
      const snapshot = agent.snapshot();
      if (snapshot.ttlMs !== undefined && snapshot.lifecycle !== "retired" && now - snapshot.createdAt > snapshot.ttlMs) agent.retire();
    }
  }

  neighbors(id: AgentId): AgentId[] {
    return this.requireAgent(id).snapshot().links.map(linkId => this.requireLink(linkId).other(id));
  }

  strongestLinks(limit = 10): LinkProtocol[] {
    return [...this.links.values()].sort((a, b) => b.snapshot().strength - a.snapshot().strength).slice(0, limit);
  }

  projection(): {
    nodes: number;
    edges: number;
    activeAgents: number;
    activeLinks: number;
    probationLinks: number;
    dormantLinks: number;
    averageStrength: number;
  } {
    const agents = [...this.agents.values()].map(agent => agent.snapshot());
    const links = [...this.links.values()].map(link => link.snapshot());
    return {
      nodes: agents.length,
      edges: links.length,
      activeAgents: agents.filter(agent => agent.lifecycle === "active").length,
      activeLinks: links.filter(link => link.lifecycle === "active" || link.lifecycle === "strengthening").length,
      probationLinks: links.filter(link => link.lifecycle === "probation").length,
      dormantLinks: links.filter(link => link.lifecycle === "dormant").length,
      averageStrength: links.length ? links.reduce((sum, link) => sum + link.strength, 0) / links.length : 0
    };
  }

  detectClusters(minStrength = 0.5): AgentId[][] {
    const seen = new Set<AgentId>();
    const clusters: AgentId[][] = [];
    for (const id of [...this.agents.keys()].sort()) {
      if (seen.has(id)) continue;
      const cluster: AgentId[] = [];
      const queue: AgentId[] = [id];
      seen.add(id);
      while (queue.length) {
        const current = queue.shift();
        if (current === undefined) break;
        cluster.push(current);
        for (const linkId of this.requireAgent(current).snapshot().links) {
          const link = this.requireLink(linkId);
          const snapshot = link.snapshot();
          if (snapshot.lifecycle === "retired" || snapshot.strength < minStrength) continue;
          const neighbor = link.other(current);
          if (!seen.has(neighbor)) {
            seen.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      clusters.push(cluster.sort());
    }
    return clusters.sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
  }

  assertIntegrity(): void {
    for (const [id, link] of this.links) {
      const snapshot = link.snapshot();
      if (!this.agents.has(snapshot.left) || !this.agents.has(snapshot.right)) throw new ProtocolViolation(`link ${id} points to missing agent`);
      if (!this.requireAgent(snapshot.left).snapshot().links.includes(id) || !this.requireAgent(snapshot.right).snapshot().links.includes(id)) {
        throw new ProtocolViolation(`link ${id} not mirrored in agents`);
      }
    }
    for (const agent of this.agents.values()) {
      for (const linkId of agent.snapshot().links) {
        const link = this.links.get(linkId);
        if (!link) throw new ProtocolViolation(`agent ${agent.id} points to missing link ${linkId}`);
        const snapshot = link.snapshot();
        if (snapshot.left !== agent.id && snapshot.right !== agent.id) throw new ProtocolViolation(`agent ${agent.id} references unrelated link ${linkId}`);
      }
    }
  }

  snapshot(): UniverseSnapshot {
    return {
      agents: [...this.agents.values()].map(agent => agent.snapshot()),
      links: [...this.links.values()].map(link => link.snapshot()),
      retiredLinks: [...this.retiredLinks.values()]
    };
  }

  requireAgent(id: AgentId): NanoAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new NotFoundError(`agent ${id} not found`);
    return agent;
  }

  requireLink(id: LinkId): LinkProtocol {
    const link = this.links.get(id);
    if (!link) throw new NotFoundError(`link ${id} not found`);
    return link;
  }

  #authorize(actor: AgentId, action: string, resource: string): void {
    this.#constitution?.authorize({ actor, action, resource });
  }
}
