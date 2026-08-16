import { canonicalJson, sha256 } from "./identity.js";
import type { FractalGraphPort, FractalProjection, JsonValue, MetaAgentView } from "./types.js";

export type MetaAgentEvent =
  | { type: "candidate"; members: string[]; stableTicks: number }
  | { type: "folded"; metaAgent: MetaAgentView }
  | { type: "unfolded"; metaAgent: MetaAgentView; reason: string };

export interface ContinuousMetaAgentOptions {
  intervalMs?: number;
  minStrength?: number;
  minimumMembers?: number;
  stableTicks?: number;
  unfoldBelowStrength?: number;
  unfoldTicks?: number;
  maxDepth?: number;
  onEvent?: (event: MetaAgentEvent) => void | Promise<void>;
  fold?: (members: string[], requestedId: string) => MetaAgentView | null | Promise<MetaAgentView | null>;
  unfold?: (metaAgentId: string) => MetaAgentView | null | Promise<MetaAgentView | null>;
}

export class ContinuousMetaAgentController {
  readonly #candidateTicks = new Map<string, number>();
  readonly #weakTicks = new Map<string, number>();
  readonly #autoMetaAgents = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(readonly graph: FractalGraphPort, readonly options: ContinuousMetaAgentOptions = {}) {}

  start(): void {
    if (this.#timer) return;
    const interval = Math.max(10, this.options.intervalMs ?? 1_000);
    this.#timer = setInterval(() => void this.tick().catch(() => undefined), interval);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<{ folded: MetaAgentView[]; unfolded: MetaAgentView[] }> {
    if (this.#running) return { folded: [], unfolded: [] };
    this.#running = true;
    try {
      const folded: MetaAgentView[] = [];
      const unfolded: MetaAgentView[] = [];
      const projection = this.graph.projection();
      for (const meta of projection.metaAgents) {
        if (meta.id.startsWith("meta:auto:")) this.#autoMetaAgents.add(meta.id);
      }
      const candidates = this.graph.detectClusters(
        this.options.minStrength ?? 0.7,
        this.options.minimumMembers ?? 2,
      );
      const seenCandidateKeys = new Set<string>();

      for (const members of candidates) {
        const normalized = [...new Set(members)].sort();
        if (!this.#withinDepth(normalized, projection)) continue;
        const key = normalized.join("|");
        seenCandidateKeys.add(key);
        const stable = (this.#candidateTicks.get(key) ?? 0) + 1;
        this.#candidateTicks.set(key, stable);
        await this.options.onEvent?.({ type: "candidate", members: normalized, stableTicks: stable });
        if (stable < (this.options.stableTicks ?? 3)) continue;
        const id = automaticMetaAgentId(normalized, projection);
        if (this.graph.getMetaAgent(id)) continue;
        try {
          const metaAgent = this.options.fold
            ? await this.options.fold(normalized, id)
            : this.graph.foldCluster(normalized, id);
          if (!metaAgent) continue;
          this.#autoMetaAgents.add(metaAgent.id);
          this.#candidateTicks.delete(key);
          folded.push(metaAgent);
          await this.options.onEvent?.({ type: "folded", metaAgent });
        } catch {
          // Another concurrent fold may have consumed one of the members.
        }
      }
      for (const key of [...this.#candidateTicks.keys()]) {
        if (!seenCandidateKeys.has(key)) this.#candidateTicks.delete(key);
      }

      const afterFolds = this.graph.projection();
      const metaAgents = afterFolds.metaAgents.filter((meta) => this.#autoMetaAgents.has(meta.id));
      for (const meta of metaAgents) {
        const incident = afterFolds.links.filter((link) => link.left === meta.id || link.right === meta.id);
        if (incident.length === 0) {
          this.#weakTicks.delete(meta.id);
          continue;
        }
        const average = incident.reduce((sum, link) => sum + link.strength, 0) / incident.length;
        if (average >= (this.options.unfoldBelowStrength ?? 0.25)) {
          this.#weakTicks.delete(meta.id);
          continue;
        }
        const weak = (this.#weakTicks.get(meta.id) ?? 0) + 1;
        this.#weakTicks.set(meta.id, weak);
        if (weak < (this.options.unfoldTicks ?? 3)) continue;
        try {
          const unfoldedMeta = this.options.unfold
            ? await this.options.unfold(meta.id)
            : this.graph.unfold(meta.id);
          if (!unfoldedMeta) continue;
          this.#weakTicks.delete(meta.id);
          this.#autoMetaAgents.delete(meta.id);
          unfolded.push(unfoldedMeta);
          await this.options.onEvent?.({
            type: "unfolded",
            metaAgent: unfoldedMeta,
            reason: `boundary cohesion ${average.toFixed(4)} below threshold`,
          });
        } catch {
          // The metaagent may have been folded into a higher-order parent.
        }
      }
      return { folded, unfolded };
    } finally {
      this.#running = false;
    }
  }

  #withinDepth(members: string[], projection: FractalProjection): boolean {
    const maxDepth = this.options.maxDepth ?? 8;
    let childDepth = 0;
    for (const id of members) {
      const meta = projection.metaAgents.find((value) => value.id === id);
      childDepth = Math.max(childDepth, meta?.depth ?? 0);
    }
    return childDepth + 1 <= maxDepth;
  }
}

function automaticMetaAgentId(members: string[], projection: FractalProjection): string {
  const payload: JsonValue = {
    members,
    agents: members.map((id) => {
      const agent = projection.agents.find((value) => value.id === id);
      return { id, capabilities: agent?.capabilities ?? [], kind: agent?.kind ?? "nano" };
    }),
  };
  return `meta:auto:${sha256(canonicalJson(payload)).slice(0, 24)}`;
}
