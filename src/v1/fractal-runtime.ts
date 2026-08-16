import { randomUUID } from "node:crypto";
import { sha256, canonicalJson, type JsonObject, type JsonValue } from "./security-transport.js";

export interface FractalAgent {
  id: string;
  kind: "nano" | "meta";
  capabilities: string[];
  exposedState: JsonObject;
  parentMetaAgentId?: string;
  lineage: string[];
}

export interface FractalLink {
  id: string;
  left: string;
  right: string;
  protocol: JsonObject;
  strength: number;
}

export interface MetaAgentRecord extends FractalAgent {
  kind: "meta";
  members: string[];
  internalAgents: FractalAgent[];
  internalLinks: FractalLink[];
  boundaryRewrites: Array<{ linkId: string; originalLeft: string; originalRight: string }>;
  depth: number;
  clusterDigest: string;
  foldedAt: number;
}

export interface FractalProjection {
  agents: FractalAgent[];
  links: FractalLink[];
  metaAgents: MetaAgentRecord[];
}

export class FractalUniverse {
  readonly #agents = new Map<string, FractalAgent>();
  readonly #links = new Map<string, FractalLink>();
  readonly #metaAgents = new Map<string, MetaAgentRecord>();

  addAgent(agent: Omit<FractalAgent, "kind" | "lineage"> & Partial<Pick<FractalAgent, "kind" | "lineage">>): FractalAgent {
    if (this.#agents.has(agent.id)) throw new Error(`Agent ${agent.id} already exists`);
    const value: FractalAgent = {
      id: agent.id,
      kind: agent.kind ?? "nano",
      capabilities: [...new Set(agent.capabilities)].sort(),
      exposedState: structuredClone(agent.exposedState),
      ...(agent.parentMetaAgentId ? { parentMetaAgentId: agent.parentMetaAgentId } : {}),
      lineage: [...(agent.lineage ?? [])],
    };
    this.#agents.set(value.id, value);
    return structuredClone(value);
  }

  addLink(link: Omit<FractalLink, "id"> & { id?: string }): FractalLink {
    if (!this.#agents.has(link.left) || !this.#agents.has(link.right)) throw new Error("Both link participants must exist");
    const value: FractalLink = {
      id: link.id ?? `link:${randomUUID()}`,
      left: link.left,
      right: link.right,
      protocol: structuredClone(link.protocol),
      strength: clamp01(link.strength),
    };
    if (this.#links.has(value.id)) throw new Error(`Link ${value.id} already exists`);
    this.#links.set(value.id, value);
    return structuredClone(value);
  }

  getAgent(id: string): FractalAgent | undefined {
    const agent = this.#agents.get(id);
    return agent ? structuredClone(agent) : undefined;
  }

  getMetaAgent(id: string): MetaAgentRecord | undefined {
    const value = this.#metaAgents.get(id);
    return value ? structuredClone(value) : undefined;
  }

  detectClusters(minStrength = 0.65, minimumMembers = 2): string[][] {
    const active = [...this.#agents.values()].filter((agent) => !agent.parentMetaAgentId).map((agent) => agent.id);
    const adjacency = new Map(active.map((id) => [id, new Set<string>()]));
    for (const link of this.#links.values()) {
      if (link.strength < minStrength || !adjacency.has(link.left) || !adjacency.has(link.right)) continue;
      adjacency.get(link.left)!.add(link.right);
      adjacency.get(link.right)!.add(link.left);
    }
    const visited = new Set<string>();
    const clusters: string[][] = [];
    for (const start of active.sort()) {
      if (visited.has(start)) continue;
      const stack = [start];
      const component: string[] = [];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);
        for (const neighbor of adjacency.get(current) ?? []) if (!visited.has(neighbor)) stack.push(neighbor);
      }
      if (component.length >= minimumMembers) clusters.push(component.sort());
    }
    return clusters;
  }

  foldCluster(memberIds: string[], requestedId?: string): MetaAgentRecord {
    const members = [...new Set(memberIds)].sort();
    if (members.length < 2) throw new Error("A metaagent must fold at least two members");
    const internalAgents = members.map((id) => {
      const agent = this.#agents.get(id);
      if (!agent) throw new Error(`Unknown cluster member ${id}`);
      if (agent.parentMetaAgentId) throw new Error(`${id} is already folded into ${agent.parentMetaAgentId}`);
      return structuredClone(agent);
    });
    const memberSet = new Set(members);
    const internalLinks = [...this.#links.values()].filter((link) => memberSet.has(link.left) && memberSet.has(link.right)).map((link) => structuredClone(link));
    const boundaryLinks = [...this.#links.values()].filter((link) => memberSet.has(link.left) !== memberSet.has(link.right));
    const digestPayload: JsonValue = {
      members: internalAgents.map((agent) => ({ id: agent.id, capabilities: agent.capabilities, exposedState: agent.exposedState })),
      links: internalLinks.map((link) => ({ left: link.left, right: link.right, protocol: link.protocol, strength: link.strength })),
    };
    const clusterDigest = sha256(canonicalJson(digestPayload));
    const id = requestedId ?? `meta:${clusterDigest.slice(0, 24)}`;
    if (this.#agents.has(id)) throw new Error(`Metaagent ${id} already exists`);
    const childDepth = internalAgents.reduce((depth, agent) => {
      const meta = this.#metaAgents.get(agent.id);
      return Math.max(depth, meta?.depth ?? 0);
    }, 0);
    const meta: MetaAgentRecord = {
      id,
      kind: "meta",
      capabilities: [...new Set(internalAgents.flatMap((agent) => agent.capabilities))].sort(),
      exposedState: {
        memberCount: members.length,
        internalLinkCount: internalLinks.length,
        clusterDigest,
      },
      lineage: internalAgents.flatMap((agent) => [agent.id, ...agent.lineage]),
      members,
      internalAgents,
      internalLinks,
      boundaryRewrites: [],
      depth: childDepth + 1,
      clusterDigest,
      foldedAt: Date.now(),
    };
    this.#agents.set(meta.id, meta);
    this.#metaAgents.set(meta.id, meta);
    for (const agent of internalAgents) this.#agents.set(agent.id, { ...agent, parentMetaAgentId: meta.id });
    for (const link of internalLinks) this.#links.delete(link.id);
    for (const link of boundaryLinks) {
      meta.boundaryRewrites.push({ linkId: link.id, originalLeft: link.left, originalRight: link.right });
      if (memberSet.has(link.left)) link.left = meta.id;
      if (memberSet.has(link.right)) link.right = meta.id;
      if (link.left === link.right) this.#links.delete(link.id);
      else this.#links.set(link.id, link);
    }
    return structuredClone(meta);
  }

  unfold(metaAgentId: string): MetaAgentRecord {
    const meta = this.#metaAgents.get(metaAgentId);
    if (!meta) throw new Error(`Unknown metaagent ${metaAgentId}`);
    for (const rewrite of meta.boundaryRewrites) {
      const link = this.#links.get(rewrite.linkId);
      if (!link) continue;
      link.left = rewrite.originalLeft;
      link.right = rewrite.originalRight;
      this.#links.set(link.id, link);
    }
    for (const agent of meta.internalAgents) {
      const current = this.#agents.get(agent.id);
      this.#agents.set(agent.id, { ...(current ?? agent), parentMetaAgentId: undefined });
    }
    for (const link of meta.internalLinks) this.#links.set(link.id, structuredClone(link));
    this.#agents.delete(meta.id);
    this.#metaAgents.delete(meta.id);
    return structuredClone(meta);
  }

  foldDetectedClusters(options: { minStrength?: number; minimumMembers?: number } = {}): MetaAgentRecord[] {
    return this.detectClusters(options.minStrength ?? 0.65, options.minimumMembers ?? 2).map((members) => this.foldCluster(members));
  }

  projection(): FractalProjection {
    return {
      agents: [...this.#agents.values()].map((value) => structuredClone(value)),
      links: [...this.#links.values()].map((value) => structuredClone(value)),
      metaAgents: [...this.#metaAgents.values()].map((value) => structuredClone(value)),
    };
  }

  static fromProjection(projection: FractalProjection): FractalUniverse {
    const universe = new FractalUniverse();
    for (const agent of projection.agents) universe.#agents.set(agent.id, structuredClone(agent));
    for (const link of projection.links) universe.#links.set(link.id, structuredClone(link));
    for (const meta of projection.metaAgents) universe.#metaAgents.set(meta.id, structuredClone(meta));
    return universe;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Link strength must be finite");
  return Math.max(0, Math.min(1, value));
}
