import { randomUUID } from "node:crypto";
import { PersistentResourceEconomy } from "./persistent-market.js";
import type {
  AgentCognitivePort,
  CognitiveAction,
  CognitiveDecision,
  JsonObject,
  JsonValue,
  LlmCompletionPort,
  LlmRequest,
  LlmResponse,
} from "./types.js";

export interface CognitiveBillingPolicy {
  providerAccount: string;
  reserveOutputTokens?: number;
  tokenSafetyFactor?: number;
  inputCreditsPerThousand?: number;
  outputCreditsPerThousand?: number;
}

export interface ThoughtResult {
  id: string;
  agentId: string;
  response: LlmResponse;
  decision: CognitiveDecision;
  chargedModelTokens: number;
  chargedCredits: number;
  actions: CognitiveAction[];
  startedAt: number;
  completedAt: number;
}

export interface ThoughtOptions {
  input?: JsonObject;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  providerPolicy?: { require?: string[]; prefer?: string[]; maxEstimatedCost?: number };
  actionHandler?: (agent: AgentCognitivePort, action: CognitiveAction) => void | Promise<void>;
  signal?: AbortSignal;
}

export class MeteredCognitiveLoop {
  constructor(
    readonly economy: PersistentResourceEconomy,
    readonly llm: LlmCompletionPort,
    readonly billing: CognitiveBillingPolicy,
  ) {}

  async think(agent: AgentCognitivePort, options: ThoughtOptions = {}): Promise<ThoughtResult> {
    const startedAt = Date.now();
    const thoughtId = `thought:${randomUUID()}`;
    const snapshot = agent.snapshot();
    const request = buildRequest(snapshot, options);
    const inputEstimate = estimateTokens(request.messages.map((message) => message.content).join("\n"));
    const outputReserve = options.maxTokens ?? this.billing.reserveOutputTokens ?? 1024;
    const tokenReserve = Math.max(1, Math.ceil((inputEstimate + outputReserve) * (this.billing.tokenSafetyFactor ?? 1.15)));
    const creditReserve = estimateCreditCharge(
      inputEstimate,
      outputReserve,
      this.billing.inputCreditsPerThousand ?? 0,
      this.billing.outputCreditsPerThousand ?? 0,
    );

    const tokenReservation = await this.economy.reserve(
      agent.id,
      "model_tokens",
      tokenReserve,
      `${thoughtId}:tokens`,
      "LLM thought token reserve",
    );
    let creditReservation: { reservationId: string; account: string } | undefined;
    try {
      if (creditReserve > 0) {
        creditReservation = await this.economy.reserve(
          agent.id,
          "credits",
          creditReserve,
          `${thoughtId}:credits`,
          "LLM thought credit reserve",
        );
      }

      const response = await this.llm.complete(
        request,
        { require: ["chat", "json"], ...(options.providerPolicy ?? {}) },
        options.signal,
      );
      const chargedModelTokens = Math.max(1, response.usage.totalTokens || estimateTokens(response.content));
      await ensureReservationCapacity(
        this.economy,
        agent.id,
        tokenReservation.account,
        "model_tokens",
        chargedModelTokens,
        tokenReserve,
        thoughtId,
      );
      await this.economy.settleReservation(
        tokenReservation.reservationId,
        this.billing.providerAccount,
        "model_tokens",
        chargedModelTokens,
        agent.id,
        "LLM token usage settlement",
      );

      const chargedCredits = estimateCreditCharge(
        response.usage.inputTokens,
        response.usage.outputTokens,
        this.billing.inputCreditsPerThousand ?? 0,
        this.billing.outputCreditsPerThousand ?? 0,
      );
      if (creditReservation) {
        await ensureReservationCapacity(
          this.economy,
          agent.id,
          creditReservation.account,
          "credits",
          chargedCredits,
          creditReserve,
          thoughtId,
        );
        if (chargedCredits > 0) {
          await this.economy.settleReservation(
            creditReservation.reservationId,
            this.billing.providerAccount,
            "credits",
            chargedCredits,
            agent.id,
            "LLM credit usage settlement",
          );
        } else {
          await this.economy.refundReservation(creditReservation.reservationId, agent.id, "credits");
        }
      } else if (chargedCredits > 0) {
        await this.economy.transfer(
          agent.id,
          this.billing.providerAccount,
          "credits",
          chargedCredits,
          "LLM credit usage settlement",
          thoughtId,
        );
      }

      agent.consumeBudget?.("tokens", chargedModelTokens);
      agent.consumeBudget?.("latencyMs", response.latencyMs);
      const decision = parseDecision(response.content);
      applyDecision(agent, decision);
      const actions = decision.actions ?? [];
      for (const action of actions) await options.actionHandler?.(agent, action);
      const completedAt = Date.now();
      agent.setEphemeral?.({
        lastThought: {
          id: thoughtId,
          provider: response.provider,
          model: response.model,
          chargedModelTokens,
          chargedCredits,
          startedAt,
          completedAt,
          summary: decision.summary ?? "",
        },
      });
      return {
        id: thoughtId,
        agentId: agent.id,
        response,
        decision,
        chargedModelTokens,
        chargedCredits,
        actions,
        startedAt,
        completedAt,
      };
    } catch (error) {
      await this.economy.refundReservation(tokenReservation.reservationId, agent.id, "model_tokens");
      if (creditReservation) await this.economy.refundReservation(creditReservation.reservationId, agent.id, "credits");
      throw error;
    }
  }
}

export interface ScheduledMind {
  agent: AgentCognitivePort;
  intervalMs: number;
  input?: () => JsonObject | Promise<JsonObject>;
  options?: Omit<ThoughtOptions, "input" | "signal">;
  onResult?: (result: ThoughtResult) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

export class CognitiveScheduler {
  readonly #minds = new Map<string, ScheduledMind>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #running = new Set<string>();
  #stopped = true;

  constructor(readonly loop: MeteredCognitiveLoop) {}

  register(mind: ScheduledMind): void {
    if (!Number.isFinite(mind.intervalMs) || mind.intervalMs < 1) throw new Error("Cognitive interval must be positive");
    this.#minds.set(mind.agent.id, mind);
    if (!this.#stopped) this.#schedule(mind.agent.id, 0);
  }

  unregister(agentId: string): void {
    this.#minds.delete(agentId);
    const timer = this.#timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(agentId);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    for (const id of this.#minds.keys()) this.#schedule(id, 0);
  }

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  async runOnce(agentId: string): Promise<ThoughtResult> {
    const mind = this.#minds.get(agentId);
    if (!mind) throw new Error(`Unknown scheduled mind ${agentId}`);
    if (this.#running.has(agentId)) throw new Error(`Mind ${agentId} is already thinking`);
    this.#running.add(agentId);
    try {
      const input = await mind.input?.();
      const result = await this.loop.think(mind.agent, { ...(mind.options ?? {}), ...(input ? { input } : {}) });
      await mind.onResult?.(result);
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await mind.onError?.(normalized);
      throw normalized;
    } finally {
      this.#running.delete(agentId);
    }
  }

  wake(agentId: string): void {
    if (!this.#minds.has(agentId)) throw new Error(`Unknown scheduled mind ${agentId}`);
    const timer = this.#timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.#schedule(agentId, 0);
  }

  #schedule(agentId: string, delay?: number): void {
    if (this.#stopped) return;
    const mind = this.#minds.get(agentId);
    if (!mind) return;
    const timer = setTimeout(() => {
      this.#timers.delete(agentId);
      void this.runOnce(agentId)
        .catch(() => undefined)
        .finally(() => this.#schedule(agentId, mind.intervalMs));
    }, delay ?? mind.intervalMs);
    timer.unref?.();
    this.#timers.set(agentId, timer);
  }
}

function buildRequest(snapshot: ReturnType<AgentCognitivePort["snapshot"]>, options: ThoughtOptions): LlmRequest {
  const system = options.systemPrompt ?? [
    "You are the cognitive process of a bounded autonomous NanoAgent.",
    "Return one valid JSON object only.",
    "Allowed keys: privateState, exposedState, durableState, ephemeralState, actions, summary.",
    "Each state value must be a JSON object. actions is an array of {type,payload}.",
    "Do not claim to have executed actions; only request them through actions.",
  ].join("\n");
  const context: JsonObject = {
    objective: (snapshot.objective ?? {}) as unknown as JsonValue,
    capabilities: (snapshot.capabilities ?? []) as unknown as JsonValue,
    privateState: snapshot.privateState ?? {},
    exposedState: snapshot.exposedState ?? {},
    durableState: snapshot.durableState ?? {},
    ephemeralState: snapshot.ephemeralState ?? {},
    input: options.input ?? {},
  };
  return {
    ...(options.model ? { model: options.model } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(context) },
    ],
    responseFormat: "json",
    maxTokens: options.maxTokens ?? 1024,
    temperature: 0,
    metadata: { purpose: "nanoagent-thought" },
  };
}

function parseDecision(content: string): CognitiveDecision {
  const parsed = JSON.parse(content) as CognitiveDecision;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LLM cognitive result must be a JSON object");
  for (const key of ["privateState", "exposedState", "durableState", "ephemeralState"] as const) {
    const value = parsed[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`${key} must be a JSON object`);
    }
  }
  if (parsed.actions !== undefined) {
    if (!Array.isArray(parsed.actions)) throw new Error("actions must be an array");
    for (const action of parsed.actions) {
      if (!action || typeof action.type !== "string" || !action.payload || typeof action.payload !== "object" || Array.isArray(action.payload)) {
        throw new Error("Each cognitive action must contain a string type and object payload");
      }
    }
  }
  return parsed;
}

function applyDecision(agent: AgentCognitivePort, decision: CognitiveDecision): void {
  if (decision.privateState) agent.think?.(decision.privateState);
  if (decision.exposedState) agent.expose?.(decision.exposedState);
  if (decision.durableState) agent.remember?.(decision.durableState);
  if (decision.ephemeralState) agent.setEphemeral?.(decision.ephemeralState);
}

async function ensureReservationCapacity(
  economy: PersistentResourceEconomy,
  owner: string,
  reservationAccount: string,
  resource: "model_tokens" | "credits",
  required: number,
  reserved: number,
  reference: string,
): Promise<void> {
  if (required <= reserved) return;
  await economy.transfer(owner, reservationAccount, resource, required - reserved, "LLM reservation top-up", reference);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateCreditCharge(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  const raw = (inputTokens * inputRate + outputTokens * outputRate) / 1000;
  if (raw <= 0) return 0;
  return Math.max(1, Math.ceil(raw));
}
