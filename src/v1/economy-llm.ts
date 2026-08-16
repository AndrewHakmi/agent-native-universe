import { randomUUID } from "node:crypto";
import { type JsonObject, type JsonValue } from "./security-transport.js";

export type ResourceKind = "credits" | "compute_ms" | "model_tokens" | "storage_bytes" | "bandwidth_bytes";

export interface LedgerEntry {
  id: string;
  sequence: number;
  resource: ResourceKind;
  debit: string;
  credit: string;
  amount: number;
  reason: string;
  reference?: string;
  timestamp: number;
}

export class ResourceLedger {
  readonly #balances = new Map<string, Map<ResourceKind, number>>();
  readonly #journal: LedgerEntry[] = [];
  #sequence = 0;

  balance(account: string, resource: ResourceKind): number {
    return this.#balances.get(account)?.get(resource) ?? 0;
  }

  balances(account: string): Readonly<Record<ResourceKind, number>> {
    return {
      credits: this.balance(account, "credits"),
      compute_ms: this.balance(account, "compute_ms"),
      model_tokens: this.balance(account, "model_tokens"),
      storage_bytes: this.balance(account, "storage_bytes"),
      bandwidth_bytes: this.balance(account, "bandwidth_bytes"),
    };
  }

  mint(account: string, resource: ResourceKind, amount: number, reason = "genesis allocation"): LedgerEntry {
    return this.#post("@mint", account, resource, amount, reason);
  }

  burn(account: string, resource: ResourceKind, amount: number, reason = "resource consumption"): LedgerEntry {
    return this.#post(account, "@burn", resource, amount, reason);
  }

  transfer(
    debit: string,
    credit: string,
    resource: ResourceKind,
    amount: number,
    reason: string,
    reference?: string,
  ): LedgerEntry {
    return this.#post(debit, credit, resource, amount, reason, reference);
  }

  escrow(buyer: string, tradeId: string, amount: number): LedgerEntry {
    return this.transfer(buyer, `@escrow:${tradeId}`, "credits", amount, "market escrow", tradeId);
  }

  settleEscrow(tradeId: string, seller: string, amount: number): LedgerEntry {
    return this.transfer(`@escrow:${tradeId}`, seller, "credits", amount, "market settlement", tradeId);
  }

  refundEscrow(tradeId: string, buyer: string, amount: number): LedgerEntry {
    return this.transfer(`@escrow:${tradeId}`, buyer, "credits", amount, "market refund", tradeId);
  }

  journal(fromSequence = 1): LedgerEntry[] {
    return this.#journal.filter((entry) => entry.sequence >= fromSequence).map((entry) => ({ ...entry }));
  }

  assertConserved(resource: ResourceKind): boolean {
    let total = 0;
    for (const [account, values] of this.#balances) {
      if (account === "@mint" || account === "@burn") continue;
      total += values.get(resource) ?? 0;
    }
    const minted = this.#journal.filter((entry) => entry.resource === resource && entry.debit === "@mint").reduce((sum, entry) => sum + entry.amount, 0);
    const burned = this.#journal.filter((entry) => entry.resource === resource && entry.credit === "@burn").reduce((sum, entry) => sum + entry.amount, 0);
    return Math.abs(total - (minted - burned)) < 1e-9;
  }

  #post(debit: string, credit: string, resource: ResourceKind, amount: number, reason: string, reference?: string): LedgerEntry {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Ledger amounts must be positive safe integers");
    if (debit === credit) throw new Error("Debit and credit accounts must differ");
    if (debit !== "@mint" && this.balance(debit, resource) < amount) throw new Error(`${debit} has insufficient ${resource}`);
    this.#adjust(debit, resource, -amount);
    this.#adjust(credit, resource, amount);
    const entry: LedgerEntry = {
      id: randomUUID(),
      sequence: ++this.#sequence,
      resource,
      debit,
      credit,
      amount,
      reason,
      ...(reference ? { reference } : {}),
      timestamp: Date.now(),
    };
    this.#journal.push(entry);
    return { ...entry };
  }

  #adjust(account: string, resource: ResourceKind, delta: number): void {
    if (account === "@mint" || account === "@burn") return;
    const values = this.#balances.get(account) ?? new Map<ResourceKind, number>();
    values.set(resource, (values.get(resource) ?? 0) + delta);
    this.#balances.set(account, values);
  }
}

export interface ResourceOffer {
  id: string;
  seller: string;
  resource: Exclude<ResourceKind, "credits">;
  quantity: number;
  unitPrice: number;
  minimumFill: number;
  expiresAt: number;
}

export interface ResourceBid {
  id: string;
  buyer: string;
  resource: Exclude<ResourceKind, "credits">;
  quantity: number;
  maxUnitPrice: number;
  expiresAt: number;
}

export interface ResourceTrade {
  id: string;
  offerId: string;
  bidId: string;
  buyer: string;
  seller: string;
  resource: Exclude<ResourceKind, "credits">;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  state: "escrowed" | "settled" | "refunded";
  createdAt: number;
}

export class ResourceMarket {
  readonly #offers = new Map<string, ResourceOffer>();
  readonly #bids = new Map<string, ResourceBid>();
  readonly #trades = new Map<string, ResourceTrade>();

  constructor(readonly ledger: ResourceLedger) {}

  placeOffer(input: Omit<ResourceOffer, "id">): ResourceOffer {
    validateOrder(input.quantity, input.unitPrice, input.expiresAt);
    if (input.minimumFill <= 0 || input.minimumFill > input.quantity) throw new Error("Invalid minimum fill");
    if (this.ledger.balance(input.seller, input.resource) < input.quantity) throw new Error("Seller does not own the offered resource");
    const offer = { ...input, id: randomUUID() };
    this.#offers.set(offer.id, offer);
    return { ...offer };
  }

  placeBid(input: Omit<ResourceBid, "id">): ResourceBid {
    validateOrder(input.quantity, input.maxUnitPrice, input.expiresAt);
    if (this.ledger.balance(input.buyer, "credits") < input.quantity * input.maxUnitPrice) throw new Error("Buyer cannot fund the bid");
    const bid = { ...input, id: randomUUID() };
    this.#bids.set(bid.id, bid);
    return { ...bid };
  }

  match(now = Date.now()): ResourceTrade[] {
    const trades: ResourceTrade[] = [];
    const bids = [...this.#bids.values()].filter((bid) => bid.expiresAt > now).sort((a, b) => b.maxUnitPrice - a.maxUnitPrice);
    const offers = [...this.#offers.values()].filter((offer) => offer.expiresAt > now).sort((a, b) => a.unitPrice - b.unitPrice);
    for (const bid of bids) {
      for (const offer of offers) {
        if (bid.resource !== offer.resource || bid.maxUnitPrice < offer.unitPrice) continue;
        const quantity = Math.min(bid.quantity, offer.quantity);
        if (quantity < offer.minimumFill) continue;
        const totalPrice = quantity * offer.unitPrice;
        if (!Number.isSafeInteger(totalPrice)) throw new Error("Trade price exceeds safe integer range");
        const trade: ResourceTrade = {
          id: randomUUID(),
          offerId: offer.id,
          bidId: bid.id,
          buyer: bid.buyer,
          seller: offer.seller,
          resource: offer.resource,
          quantity,
          unitPrice: offer.unitPrice,
          totalPrice,
          state: "escrowed",
          createdAt: now,
        };
        this.ledger.escrow(bid.buyer, trade.id, totalPrice);
        this.#trades.set(trade.id, trade);
        bid.quantity -= quantity;
        offer.quantity -= quantity;
        if (bid.quantity === 0) this.#bids.delete(bid.id);
        if (offer.quantity === 0) this.#offers.delete(offer.id);
        trades.push({ ...trade });
        break;
      }
    }
    return trades;
  }

  settle(tradeId: string): ResourceTrade {
    const trade = this.#requireTrade(tradeId);
    if (trade.state !== "escrowed") throw new Error(`Trade ${tradeId} is already ${trade.state}`);
    this.ledger.transfer(trade.seller, trade.buyer, trade.resource, trade.quantity, "resource delivery", trade.id);
    this.ledger.settleEscrow(trade.id, trade.seller, trade.totalPrice);
    trade.state = "settled";
    return { ...trade };
  }

  refund(tradeId: string): ResourceTrade {
    const trade = this.#requireTrade(tradeId);
    if (trade.state !== "escrowed") throw new Error(`Trade ${tradeId} is already ${trade.state}`);
    this.ledger.refundEscrow(trade.id, trade.buyer, trade.totalPrice);
    trade.state = "refunded";
    return { ...trade };
  }

  #requireTrade(id: string): ResourceTrade {
    const trade = this.#trades.get(id);
    if (!trade) throw new Error(`Unknown trade ${id}`);
    return trade;
  }
}

function validateOrder(quantity: number, price: number, expiresAt: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Order quantity must be a positive safe integer");
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Order price must be a positive safe integer");
  if (expiresAt <= Date.now()) throw new Error("Order is already expired");
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LlmRequest {
  model?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  metadata?: JsonObject;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  provider: string;
  model: string;
  content: string;
  usage: LlmUsage;
  latencyMs: number;
  raw?: JsonValue;
}

export interface LlmProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<string>;
  readonly estimatedInputCostPerMillion: number;
  readonly estimatedOutputCostPerMillion: number;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  health(): { healthy: boolean; consecutiveFailures: number; lastLatencyMs?: number };
}

abstract class HttpLlmProvider implements LlmProvider {
  abstract readonly id: string;
  abstract readonly capabilities: ReadonlySet<string>;
  abstract readonly estimatedInputCostPerMillion: number;
  abstract readonly estimatedOutputCostPerMillion: number;
  #failures = 0;
  #lastLatencyMs?: number;

  constructor(
    readonly config: { baseUrl: string; apiKey?: string; defaultModel: string; timeoutMs?: number },
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  health(): { healthy: boolean; consecutiveFailures: number; lastLatencyMs?: number } {
    return { healthy: this.#failures < 3, consecutiveFailures: this.#failures, ...(this.#lastLatencyMs === undefined ? {} : { lastLatencyMs: this.#lastLatencyMs }) };
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.perform(request, combined);
      this.#failures = 0;
      this.#lastLatencyMs = Date.now() - started;
      return { ...response, latencyMs: this.#lastLatencyMs };
    } catch (error) {
      this.#failures += 1;
      this.#lastLatencyMs = Date.now() - started;
      throw error;
    }
  }

  protected abstract perform(request: LlmRequest, signal: AbortSignal): Promise<Omit<LlmResponse, "latencyMs">>;

  protected async post(path: string, body: JsonObject, headers: Record<string, string>, signal: AbortSignal): Promise<JsonObject> {
    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`${this.id} returned HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as JsonObject;
  }
}

export class OpenAICompatibleProvider extends HttpLlmProvider {
  readonly id = "openai-compatible";
  readonly capabilities = new Set(["chat", "json", "tools"]);
  readonly estimatedInputCostPerMillion: number;
  readonly estimatedOutputCostPerMillion: number;

  constructor(
    config: { baseUrl?: string; apiKey?: string; defaultModel: string; timeoutMs?: number; inputCostPerMillion?: number; outputCostPerMillion?: number },
    fetchImpl?: typeof fetch,
  ) {
    super({
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
      defaultModel: config.defaultModel,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    }, fetchImpl);
    this.estimatedInputCostPerMillion = config.inputCostPerMillion ?? 0;
    this.estimatedOutputCostPerMillion = config.outputCostPerMillion ?? 0;
  }

  protected async perform(request: LlmRequest, signal: AbortSignal): Promise<Omit<LlmResponse, "latencyMs">> {
    const model = request.model ?? this.config.defaultModel;
    const body: JsonObject = {
      model,
      messages: request.messages as unknown as JsonValue,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    };
    const json = await this.post("/chat/completions", body, this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}, signal);
    const choices = json.choices as JsonValue[] | undefined;
    const first = choices?.[0] as JsonObject | undefined;
    const message = first?.message as JsonObject | undefined;
    const usage = (json.usage as JsonObject | undefined) ?? {};
    const input = Number(usage.prompt_tokens ?? 0);
    const output = Number(usage.completion_tokens ?? 0);
    return {
      provider: this.id,
      model,
      content: String(message?.content ?? ""),
      usage: { inputTokens: input, outputTokens: output, totalTokens: Number(usage.total_tokens ?? input + output) },
      raw: json,
    };
  }
}

export class AnthropicProvider extends HttpLlmProvider {
  readonly id = "anthropic";
  readonly capabilities = new Set(["chat", "json", "tools"]);
  readonly estimatedInputCostPerMillion: number;
  readonly estimatedOutputCostPerMillion: number;

  constructor(
    config: { apiKey: string; defaultModel: string; baseUrl?: string; timeoutMs?: number; inputCostPerMillion?: number; outputCostPerMillion?: number },
    fetchImpl?: typeof fetch,
  ) {
    super({
      baseUrl: config.baseUrl ?? "https://api.anthropic.com",
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    }, fetchImpl);
    this.estimatedInputCostPerMillion = config.inputCostPerMillion ?? 0;
    this.estimatedOutputCostPerMillion = config.outputCostPerMillion ?? 0;
  }

  protected async perform(request: LlmRequest, signal: AbortSignal): Promise<Omit<LlmResponse, "latencyMs">> {
    const model = request.model ?? this.config.defaultModel;
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = request.messages.filter((message) => message.role !== "system");
    const json = await this.post(
      "/v1/messages",
      {
        model,
        max_tokens: request.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages: messages as unknown as JsonValue,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      },
      { "x-api-key": this.config.apiKey ?? "", "anthropic-version": "2023-06-01" },
      signal,
    );
    const blocks = (json.content as JsonValue[] | undefined) ?? [];
    const content = blocks
      .map((block) => (block as JsonObject).text)
      .filter((text): text is string => typeof text === "string")
      .join("");
    const usage = (json.usage as JsonObject | undefined) ?? {};
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    return { provider: this.id, model, content, usage: { inputTokens: input, outputTokens: output, totalTokens: input + output }, raw: json };
  }
}

export class OllamaProvider extends HttpLlmProvider {
  readonly id = "ollama";
  readonly capabilities = new Set(["chat", "json", "local"]);
  readonly estimatedInputCostPerMillion = 0;
  readonly estimatedOutputCostPerMillion = 0;

  constructor(config: { defaultModel: string; baseUrl?: string; timeoutMs?: number }, fetchImpl?: typeof fetch) {
    super({
      baseUrl: config.baseUrl ?? "http://127.0.0.1:11434",
      defaultModel: config.defaultModel,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    }, fetchImpl);
  }

  protected async perform(request: LlmRequest, signal: AbortSignal): Promise<Omit<LlmResponse, "latencyMs">> {
    const model = request.model ?? this.config.defaultModel;
    const json = await this.post(
      "/api/chat",
      {
        model,
        stream: false,
        messages: request.messages as unknown as JsonValue,
        ...(request.responseFormat === "json" ? { format: "json" } : {}),
        options: { ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }) },
      },
      {},
      signal,
    );
    const message = (json.message as JsonObject | undefined) ?? {};
    const input = Number(json.prompt_eval_count ?? 0);
    const output = Number(json.eval_count ?? 0);
    return { provider: this.id, model, content: String(message.content ?? ""), usage: { inputTokens: input, outputTokens: output, totalTokens: input + output }, raw: json };
  }
}

export class LlmRouter {
  readonly #providers = new Map<string, LlmProvider>();

  register(provider: LlmProvider): void {
    this.#providers.set(provider.id, provider);
  }

  async complete(
    request: LlmRequest,
    policy: { require?: string[]; prefer?: string[]; maxEstimatedCost?: number } = {},
    signal?: AbortSignal,
  ): Promise<LlmResponse> {
    const required = new Set(policy.require ?? []);
    const preferred = policy.prefer ?? [];
    const providers = [...this.#providers.values()]
      .filter((provider) => provider.health().healthy)
      .filter((provider) => [...required].every((capability) => provider.capabilities.has(capability)))
      .sort((a, b) => {
        const preference = indexScore(preferred, a.id) - indexScore(preferred, b.id);
        if (preference !== 0) return preference;
        const costA = a.estimatedInputCostPerMillion + a.estimatedOutputCostPerMillion;
        const costB = b.estimatedInputCostPerMillion + b.estimatedOutputCostPerMillion;
        return costA - costB;
      });
    if (providers.length === 0) throw new Error("No healthy LLM provider satisfies the routing policy");
    const errors: Error[] = [];
    for (const provider of providers) {
      const estimated = provider.estimatedInputCostPerMillion + provider.estimatedOutputCostPerMillion;
      if (policy.maxEstimatedCost !== undefined && estimated > policy.maxEstimatedCost) continue;
      try {
        return await provider.complete(request, signal);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    throw new AggregateError(errors, "All eligible LLM providers failed");
  }
}

function indexScore(preferred: string[], id: string): number {
  const index = preferred.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
