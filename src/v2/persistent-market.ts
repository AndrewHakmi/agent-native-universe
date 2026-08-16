import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceKind } from "./types.js";

export interface EconomyEntry {
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

export interface PersistentOffer {
  id: string;
  seller: string;
  resource: Exclude<ResourceKind, "credits">;
  quantity: number;
  remaining: number;
  unitPrice: number;
  minimumFill: number;
  expiresAt: number;
  escrowAccount: string;
  state: "open" | "filled" | "cancelled" | "expired";
}

export interface PersistentBid {
  id: string;
  buyer: string;
  resource: Exclude<ResourceKind, "credits">;
  quantity: number;
  remaining: number;
  maxUnitPrice: number;
  reservedCredits: number;
  expiresAt: number;
  escrowAccount: string;
  state: "open" | "filled" | "cancelled" | "expired";
}

export interface PersistentTrade {
  id: string;
  offerId: string;
  bidId: string;
  buyer: string;
  seller: string;
  resource: Exclude<ResourceKind, "credits">;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  resourceEscrow: string;
  creditEscrow: string;
  state: "escrowed" | "settled" | "refunded";
  createdAt: number;
}

interface EconomyState {
  format: 2;
  sequence: number;
  balances: Record<string, Partial<Record<ResourceKind, number>>>;
  entries: EconomyEntry[];
  offers: PersistentOffer[];
  bids: PersistentBid[];
  trades: PersistentTrade[];
  updatedAt: number;
}

const EMPTY_STATE: EconomyState = {
  format: 2,
  sequence: 0,
  balances: {},
  entries: [],
  offers: [],
  bids: [],
  trades: [],
  updatedAt: 0,
};

export class PersistentResourceEconomy {
  readonly #path: string;
  #state: EconomyState = structuredClone(EMPTY_STATE);
  #chain: Promise<void> = Promise.resolve();

  private constructor(readonly directory: string) {
    this.#path = join(directory, "resource-economy.json");
  }

  static async open(directory: string): Promise<PersistentResourceEconomy> {
    const economy = new PersistentResourceEconomy(directory);
    await mkdir(directory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(economy.#path, "utf8")) as EconomyState;
      economy.#validateState(parsed);
      economy.#state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await economy.#persist();
    }
    return economy;
  }

  balance(account: string, resource: ResourceKind): number {
    return this.#state.balances[account]?.[resource] ?? 0;
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

  offers(): PersistentOffer[] {
    return structuredClone(this.#state.offers);
  }

  bids(): PersistentBid[] {
    return structuredClone(this.#state.bids);
  }

  trades(): PersistentTrade[] {
    return structuredClone(this.#state.trades);
  }

  journal(fromSequence = 1): EconomyEntry[] {
    return structuredClone(this.#state.entries.filter((entry) => entry.sequence >= fromSequence));
  }

  async mint(account: string, resource: ResourceKind, amount: number, reason = "genesis allocation"): Promise<EconomyEntry> {
    return this.#mutate(() => this.#post("@mint", account, resource, amount, reason));
  }

  async burn(account: string, resource: ResourceKind, amount: number, reason = "resource consumed", reference?: string): Promise<EconomyEntry> {
    return this.#mutate(() => this.#post(account, "@burn", resource, amount, reason, reference));
  }

  async transfer(
    debit: string,
    credit: string,
    resource: ResourceKind,
    amount: number,
    reason: string,
    reference?: string,
  ): Promise<EconomyEntry> {
    return this.#mutate(() => this.#post(debit, credit, resource, amount, reason, reference));
  }

  async reserve(
    owner: string,
    resource: ResourceKind,
    amount: number,
    reservationId: string = randomUUID(),
    reason = "resource reservation",
  ): Promise<{ reservationId: string; account: string }> {
    const account = `@reservation:${reservationId}`;
    await this.transfer(owner, account, resource, amount, reason, reservationId);
    return { reservationId, account };
  }

  async settleReservation(
    reservationId: string,
    beneficiary: string,
    resource: ResourceKind,
    used: number,
    owner: string,
    reason = "reservation settlement",
  ): Promise<void> {
    await this.#mutate(() => {
      const account = `@reservation:${reservationId}`;
      const reserved = this.#balance(account, resource);
      assertAmount(used);
      if (used > reserved) throw new Error(`Reservation ${reservationId} has only ${reserved} ${resource}`);
      this.#post(account, beneficiary, resource, used, reason, reservationId);
      const remainder = reserved - used;
      if (remainder > 0) this.#post(account, owner, resource, remainder, "reservation refund", reservationId);
    });
  }

  async refundReservation(reservationId: string, owner: string, resource: ResourceKind): Promise<void> {
    await this.#mutate(() => {
      const account = `@reservation:${reservationId}`;
      const remaining = this.#balance(account, resource);
      if (remaining > 0) this.#post(account, owner, resource, remaining, "reservation refund", reservationId);
    });
  }

  async placeOffer(input: {
    seller: string;
    resource: Exclude<ResourceKind, "credits">;
    quantity: number;
    unitPrice: number;
    minimumFill: number;
    expiresAt: number;
  }): Promise<PersistentOffer> {
    return this.#mutate(() => {
      validateOrder(input.quantity, input.unitPrice, input.expiresAt);
      if (!Number.isSafeInteger(input.minimumFill) || input.minimumFill <= 0 || input.minimumFill > input.quantity) {
        throw new Error("Invalid minimum fill");
      }
      const id = randomUUID();
      const escrowAccount = `@offer:${id}`;
      // The seller's resource leaves the spendable balance immediately. This
      // makes double-selling impossible even across multiple open offers.
      this.#post(input.seller, escrowAccount, input.resource, input.quantity, "offer resource escrow", id);
      const offer: PersistentOffer = {
        id,
        ...input,
        remaining: input.quantity,
        escrowAccount,
        state: "open",
      };
      this.#state.offers.push(offer);
      return structuredClone(offer);
    });
  }

  async placeBid(input: {
    buyer: string;
    resource: Exclude<ResourceKind, "credits">;
    quantity: number;
    maxUnitPrice: number;
    expiresAt: number;
  }): Promise<PersistentBid> {
    return this.#mutate(() => {
      validateOrder(input.quantity, input.maxUnitPrice, input.expiresAt);
      const id = randomUUID();
      const escrowAccount = `@bid:${id}`;
      const reservedCredits = multiplySafe(input.quantity, input.maxUnitPrice);
      this.#post(input.buyer, escrowAccount, "credits", reservedCredits, "bid credit escrow", id);
      const bid: PersistentBid = {
        id,
        ...input,
        remaining: input.quantity,
        reservedCredits,
        escrowAccount,
        state: "open",
      };
      this.#state.bids.push(bid);
      return structuredClone(bid);
    });
  }

  async cancelOffer(id: string): Promise<PersistentOffer> {
    return this.#mutate(() => {
      const offer = this.#requireOffer(id);
      if (offer.state !== "open") throw new Error(`Offer ${id} is ${offer.state}`);
      const remaining = this.#balance(offer.escrowAccount, offer.resource);
      if (remaining > 0) this.#post(offer.escrowAccount, offer.seller, offer.resource, remaining, "offer cancelled", offer.id);
      offer.remaining = 0;
      offer.state = "cancelled";
      return structuredClone(offer);
    });
  }

  async cancelBid(id: string): Promise<PersistentBid> {
    return this.#mutate(() => {
      const bid = this.#requireBid(id);
      if (bid.state !== "open") throw new Error(`Bid ${id} is ${bid.state}`);
      const remaining = this.#balance(bid.escrowAccount, "credits");
      if (remaining > 0) this.#post(bid.escrowAccount, bid.buyer, "credits", remaining, "bid cancelled", bid.id);
      bid.remaining = 0;
      bid.reservedCredits = 0;
      bid.state = "cancelled";
      return structuredClone(bid);
    });
  }

  async expire(now = Date.now()): Promise<void> {
    await this.#mutate(() => {
      for (const offer of this.#state.offers) {
        if (offer.state !== "open" || offer.expiresAt > now) continue;
        const remaining = this.#balance(offer.escrowAccount, offer.resource);
        if (remaining > 0) this.#post(offer.escrowAccount, offer.seller, offer.resource, remaining, "offer expired", offer.id);
        offer.remaining = 0;
        offer.state = "expired";
      }
      for (const bid of this.#state.bids) {
        if (bid.state !== "open" || bid.expiresAt > now) continue;
        const remaining = this.#balance(bid.escrowAccount, "credits");
        if (remaining > 0) this.#post(bid.escrowAccount, bid.buyer, "credits", remaining, "bid expired", bid.id);
        bid.remaining = 0;
        bid.reservedCredits = 0;
        bid.state = "expired";
      }
    });
  }

  async match(now = Date.now()): Promise<PersistentTrade[]> {
    return this.#mutate(() => {
      const trades: PersistentTrade[] = [];
      const bids = this.#state.bids
        .filter((bid) => bid.state === "open" && bid.expiresAt > now && bid.remaining > 0)
        .sort((a, b) => b.maxUnitPrice - a.maxUnitPrice || a.id.localeCompare(b.id));
      const offers = this.#state.offers
        .filter((offer) => offer.state === "open" && offer.expiresAt > now && offer.remaining > 0)
        .sort((a, b) => a.unitPrice - b.unitPrice || a.id.localeCompare(b.id));
      for (const bid of bids) {
        for (const offer of offers) {
          if (bid.resource !== offer.resource || bid.maxUnitPrice < offer.unitPrice) continue;
          const quantity = Math.min(bid.remaining, offer.remaining);
          if (quantity < offer.minimumFill) continue;
          const totalPrice = multiplySafe(quantity, offer.unitPrice);
          const maximumReservedForFill = multiplySafe(quantity, bid.maxUnitPrice);
          const id = randomUUID();
          const resourceEscrow = `@trade-resource:${id}`;
          const creditEscrow = `@trade-credit:${id}`;
          this.#post(offer.escrowAccount, resourceEscrow, offer.resource, quantity, "trade resource escrow", id);
          this.#post(bid.escrowAccount, creditEscrow, "credits", totalPrice, "trade credit escrow", id);
          const priceImprovement = maximumReservedForFill - totalPrice;
          if (priceImprovement > 0) {
            this.#post(bid.escrowAccount, bid.buyer, "credits", priceImprovement, "bid price improvement refund", id);
          }
          offer.remaining -= quantity;
          bid.remaining -= quantity;
          bid.reservedCredits -= maximumReservedForFill;
          if (offer.remaining === 0) offer.state = "filled";
          if (bid.remaining === 0) {
            bid.state = "filled";
            const extra = this.#balance(bid.escrowAccount, "credits");
            if (extra > 0) this.#post(bid.escrowAccount, bid.buyer, "credits", extra, "completed bid remainder refund", bid.id);
            bid.reservedCredits = 0;
          }
          const trade: PersistentTrade = {
            id,
            offerId: offer.id,
            bidId: bid.id,
            buyer: bid.buyer,
            seller: offer.seller,
            resource: offer.resource,
            quantity,
            unitPrice: offer.unitPrice,
            totalPrice,
            resourceEscrow,
            creditEscrow,
            state: "escrowed",
            createdAt: now,
          };
          this.#state.trades.push(trade);
          trades.push(structuredClone(trade));
          if (bid.remaining === 0) break;
        }
      }
      return trades;
    });
  }

  async settleTrade(id: string): Promise<PersistentTrade> {
    return this.#mutate(() => {
      const trade = this.#requireTrade(id);
      if (trade.state !== "escrowed") throw new Error(`Trade ${id} is ${trade.state}`);
      this.#post(trade.resourceEscrow, trade.buyer, trade.resource, trade.quantity, "trade resource delivery", trade.id);
      this.#post(trade.creditEscrow, trade.seller, "credits", trade.totalPrice, "trade payment", trade.id);
      trade.state = "settled";
      return structuredClone(trade);
    });
  }

  async refundTrade(id: string): Promise<PersistentTrade> {
    return this.#mutate(() => {
      const trade = this.#requireTrade(id);
      if (trade.state !== "escrowed") throw new Error(`Trade ${id} is ${trade.state}`);
      this.#post(trade.resourceEscrow, trade.seller, trade.resource, trade.quantity, "trade resource refund", trade.id);
      this.#post(trade.creditEscrow, trade.buyer, "credits", trade.totalPrice, "trade credit refund", trade.id);
      trade.state = "refunded";
      return structuredClone(trade);
    });
  }

  assertConserved(resource: ResourceKind): boolean {
    let total = 0;
    for (const [account, balances] of Object.entries(this.#state.balances)) {
      if (account === "@mint" || account === "@burn") continue;
      total += balances[resource] ?? 0;
    }
    const minted = this.#state.entries
      .filter((entry) => entry.resource === resource && entry.debit === "@mint")
      .reduce((sum, entry) => sum + entry.amount, 0);
    const burned = this.#state.entries
      .filter((entry) => entry.resource === resource && entry.credit === "@burn")
      .reduce((sum, entry) => sum + entry.amount, 0);
    return total === minted - burned;
  }

  async checkpoint(): Promise<void> {
    await this.#enqueue(() => this.#persist());
  }

  async #mutate<T>(operation: () => T): Promise<T> {
    let result!: T;
    await this.#enqueue(async () => {
      const before = structuredClone(this.#state);
      try {
        result = operation();
        this.#state.updatedAt = Date.now();
        this.#validateState(this.#state);
        await this.#persist();
      } catch (error) {
        this.#state = before;
        throw error;
      }
    });
    return result;
  }

  async #enqueue(operation: () => void | Promise<void>): Promise<void> {
    const run = this.#chain.then(operation, operation);
    this.#chain = run.catch(() => undefined);
    await run;
  }

  #post(
    debit: string,
    credit: string,
    resource: ResourceKind,
    amount: number,
    reason: string,
    reference?: string,
  ): EconomyEntry {
    assertAmount(amount);
    if (debit === credit) throw new Error("Debit and credit accounts must differ");
    if (debit !== "@mint" && this.#balance(debit, resource) < amount) {
      throw new Error(`${debit} has insufficient ${resource}`);
    }
    this.#adjust(debit, resource, -amount);
    this.#adjust(credit, resource, amount);
    const entry: EconomyEntry = {
      id: randomUUID(),
      sequence: ++this.#state.sequence,
      resource,
      debit,
      credit,
      amount,
      reason,
      ...(reference ? { reference } : {}),
      timestamp: Date.now(),
    };
    this.#state.entries.push(entry);
    return structuredClone(entry);
  }

  #balance(account: string, resource: ResourceKind): number {
    return this.#state.balances[account]?.[resource] ?? 0;
  }

  #adjust(account: string, resource: ResourceKind, delta: number): void {
    if (account === "@mint" || account === "@burn") return;
    const balances = this.#state.balances[account] ?? {};
    const next = (balances[resource] ?? 0) + delta;
    if (next < 0) throw new Error(`Negative ${resource} balance for ${account}`);
    balances[resource] = next;
    this.#state.balances[account] = balances;
  }

  #requireOffer(id: string): PersistentOffer {
    const offer = this.#state.offers.find((value) => value.id === id);
    if (!offer) throw new Error(`Unknown offer ${id}`);
    return offer;
  }

  #requireBid(id: string): PersistentBid {
    const bid = this.#state.bids.find((value) => value.id === id);
    if (!bid) throw new Error(`Unknown bid ${id}`);
    return bid;
  }

  #requireTrade(id: string): PersistentTrade {
    const trade = this.#state.trades.find((value) => value.id === id);
    if (!trade) throw new Error(`Unknown trade ${id}`);
    return trade;
  }

  async #persist(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#state), "utf8");
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#path);
  }

  #validateState(state: EconomyState): void {
    if (state.format !== 2 || !Number.isSafeInteger(state.sequence) || state.sequence < 0) throw new Error("Invalid persistent economy state");
    const seenSequences = new Set<number>();
    for (const entry of state.entries) {
      assertAmount(entry.amount);
      if (seenSequences.has(entry.sequence)) throw new Error(`Duplicate economy sequence ${entry.sequence}`);
      seenSequences.add(entry.sequence);
    }
    for (const balances of Object.values(state.balances)) {
      for (const amount of Object.values(balances)) {
        if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error("Invalid resource balance");
      }
    }
    for (const resource of ["credits", "compute_ms", "model_tokens", "storage_bytes", "bandwidth_bytes"] as const) {
      if (!this.assertConservedAgainst(state, resource)) throw new Error(`Resource conservation failed for ${resource}`);
    }
  }

  assertConservedAgainst(state: EconomyState, resource: ResourceKind): boolean {
    let total = 0;
    for (const [account, balances] of Object.entries(state.balances)) {
      if (account === "@mint" || account === "@burn") continue;
      total += balances[resource] ?? 0;
    }
    const minted = state.entries.filter((entry) => entry.resource === resource && entry.debit === "@mint").reduce((sum, entry) => sum + entry.amount, 0);
    const burned = state.entries.filter((entry) => entry.resource === resource && entry.credit === "@burn").reduce((sum, entry) => sum + entry.amount, 0);
    return total === minted - burned;
  }
}

function validateOrder(quantity: number, price: number, expiresAt: number): void {
  assertAmount(quantity);
  assertAmount(price);
  if (expiresAt <= Date.now()) throw new Error("Order is already expired");
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Resource amounts must be positive safe integers");
}

function multiplySafe(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Resource multiplication exceeds safe integer range");
  return result;
}
