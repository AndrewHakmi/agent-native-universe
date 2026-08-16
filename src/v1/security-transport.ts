import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Only finite numbers are canonical JSON values");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface PublicIdentity {
  id: string;
  publicKeyPem: string;
  fingerprint: string;
  algorithm: "Ed25519";
}

export interface SignedEnvelope<T extends JsonValue = JsonValue> {
  version: 1;
  id: string;
  sender: string;
  recipient?: string;
  topic: string;
  timestamp: number;
  nonce: string;
  payload: T;
  publicKeyPem: string;
  signature: string;
}

type UnsignedEnvelope<T extends JsonValue> = Omit<SignedEnvelope<T>, "signature">;

function envelopeSigningBytes<T extends JsonValue>(envelope: UnsignedEnvelope<T>): Buffer {
  return Buffer.from(canonicalJson(envelope as unknown as JsonValue), "utf8");
}

export class CryptoIdentity {
  readonly id: string;
  readonly fingerprint: string;
  readonly publicKeyPem: string;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;

  private constructor(id: string, privateKey: KeyObject, publicKey: KeyObject) {
    this.id = id;
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
    this.publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    this.fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
  }

  static generate(id = `node:${randomUUID()}`): CryptoIdentity {
    const pair = generateKeyPairSync("ed25519");
    return new CryptoIdentity(id, pair.privateKey, pair.publicKey);
  }

  static fromPem(id: string, privateKeyPem: string, publicKeyPem: string): CryptoIdentity {
    const { createPrivateKey } = requireCrypto();
    return new CryptoIdentity(
      id,
      createPrivateKey({ key: privateKeyPem, format: "pem" }),
      createPublicKey({ key: publicKeyPem, format: "pem" }),
    );
  }

  exportPrivateKeyPem(): string {
    return this.#privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  publicIdentity(): PublicIdentity {
    return {
      id: this.id,
      publicKeyPem: this.publicKeyPem,
      fingerprint: this.fingerprint,
      algorithm: "Ed25519",
    };
  }

  sign<T extends JsonValue>(topic: string, payload: T, options: { recipient?: string; now?: number; nonce?: string } = {}): SignedEnvelope<T> {
    const unsigned: UnsignedEnvelope<T> = {
      version: 1,
      id: randomUUID(),
      sender: this.id,
      ...(options.recipient ? { recipient: options.recipient } : {}),
      topic,
      timestamp: options.now ?? Date.now(),
      nonce: options.nonce ?? randomUUID(),
      payload,
      publicKeyPem: this.publicKeyPem,
    };
    return {
      ...unsigned,
      signature: cryptoSign(null, envelopeSigningBytes(unsigned), this.#privateKey).toString("base64"),
    };
  }

  signValue(value: JsonValue): string {
    return cryptoSign(null, Buffer.from(canonicalJson(value), "utf8"), this.#privateKey).toString("base64");
  }

  verifyValue(value: JsonValue, signature: string): boolean {
    return cryptoVerify(null, Buffer.from(canonicalJson(value), "utf8"), this.#publicKey, Buffer.from(signature, "base64"));
  }
}

function requireCrypto(): typeof import("node:crypto") {
  // Kept behind a function so browser-oriented bundlers can replace the identity implementation.
  return require("node:crypto") as typeof import("node:crypto");
}

export class ReplayWindow {
  readonly #seen = new Map<string, number>();
  constructor(readonly ttlMs = 5 * 60_000, readonly maxEntries = 100_000) {}

  accept(sender: string, nonce: string, now = Date.now()): boolean {
    this.prune(now);
    const key = `${sender}:${nonce}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now + this.ttlMs);
    if (this.#seen.size > this.maxEntries) {
      const oldest = this.#seen.keys().next().value as string | undefined;
      if (oldest) this.#seen.delete(oldest);
    }
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, expiresAt] of this.#seen) if (expiresAt <= now) this.#seen.delete(key);
  }
}

export class IdentityRegistry {
  readonly #identities = new Map<string, PublicIdentity>();
  readonly #replay: ReplayWindow;

  constructor(options: { replayWindow?: ReplayWindow } = {}) {
    this.#replay = options.replayWindow ?? new ReplayWindow();
  }

  register(identity: PublicIdentity): void {
    const actualFingerprint = sha256(createPublicKey(identity.publicKeyPem).export({ type: "spki", format: "der" }));
    if (actualFingerprint !== identity.fingerprint) throw new Error(`Fingerprint mismatch for ${identity.id}`);
    const existing = this.#identities.get(identity.id);
    if (existing && existing.fingerprint !== identity.fingerprint) throw new Error(`Identity substitution attempted for ${identity.id}`);
    this.#identities.set(identity.id, { ...identity });
  }

  get(id: string): PublicIdentity | undefined {
    const value = this.#identities.get(id);
    return value ? { ...value } : undefined;
  }

  verify<T extends JsonValue>(
    envelope: SignedEnvelope<T>,
    options: { now?: number; maxClockSkewMs?: number; consumeNonce?: boolean } = {},
  ): boolean {
    if (envelope.version !== 1) return false;
    const now = options.now ?? Date.now();
    if (Math.abs(now - envelope.timestamp) > (options.maxClockSkewMs ?? 60_000)) return false;
    const trusted = this.#identities.get(envelope.sender);
    if (!trusted || trusted.publicKeyPem !== envelope.publicKeyPem) return false;
    const { signature, ...unsigned } = envelope;
    const valid = cryptoVerify(
      null,
      envelopeSigningBytes(unsigned),
      createPublicKey(envelope.publicKeyPem),
      Buffer.from(signature, "base64"),
    );
    if (!valid) return false;
    return options.consumeNonce === false ? true : this.#replay.accept(envelope.sender, envelope.nonce, now);
  }
}

export interface NetworkAddress {
  host: string;
  port: number;
}

export interface TransportMessage {
  remote: NetworkAddress;
  bytes: Uint8Array;
}

export type TransportHandler = (message: TransportMessage) => void | Promise<void>;

export class TcpTransport {
  readonly #handlers = new Set<TransportHandler>();
  #server: Server | undefined;
  #address: NetworkAddress | undefined;

  constructor(readonly options: { maxFrameBytes?: number; connectTimeoutMs?: number } = {}) {}

  get address(): NetworkAddress {
    if (!this.#address) throw new Error("Transport has not been started");
    return { ...this.#address };
  }

  onMessage(handler: TransportHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async start(address: NetworkAddress = { host: "127.0.0.1", port: 0 }): Promise<NetworkAddress> {
    if (this.#server) return this.address;
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address.port, address.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("TCP server did not expose an IP address");
    this.#address = { host: bound.address, port: bound.port };
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  async send(address: NetworkAddress, bytes: Uint8Array): Promise<void> {
    const max = this.options.maxFrameBytes ?? 8 * 1024 * 1024;
    if (bytes.byteLength > max) throw new Error(`Frame exceeds ${max} bytes`);
    const frame = Buffer.allocUnsafe(4 + bytes.byteLength);
    frame.writeUInt32BE(bytes.byteLength, 0);
    Buffer.from(bytes).copy(frame, 4);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(address);
      const timer = setTimeout(() => socket.destroy(new Error("TCP connect timeout")), this.options.connectTimeoutMs ?? 5_000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end(frame, () => resolve());
      });
    });
  }

  #accept(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    const remote: NetworkAddress = {
      host: socket.remoteAddress ?? "unknown",
      port: socket.remotePort ?? 0,
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) {
          socket.destroy(new Error("Incoming frame is too large"));
          return;
        }
        if (buffer.length < 4 + size) return;
        const bytes = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        for (const handler of this.#handlers) void Promise.resolve(handler({ remote, bytes })).catch(() => undefined);
      }
    });
  }
}

export class SecureTransport {
  readonly #handlers = new Set<(envelope: SignedEnvelope) => void | Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(
    readonly identity: CryptoIdentity,
    readonly registry: IdentityRegistry,
    readonly transport: TcpTransport,
  ) {
    this.#unsubscribe = transport.onMessage(({ bytes }) => {
      let envelope: SignedEnvelope;
      try {
        envelope = JSON.parse(Buffer.from(bytes).toString("utf8")) as SignedEnvelope;
      } catch {
        return;
      }
      if (envelope.recipient && envelope.recipient !== this.identity.id) return;
      if (!this.registry.verify(envelope)) return;
      for (const handler of this.#handlers) void Promise.resolve(handler(envelope)).catch(() => undefined);
    });
  }

  onEnvelope(handler: (envelope: SignedEnvelope) => void | Promise<void>): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async send<T extends JsonValue>(address: NetworkAddress, topic: string, payload: T, recipient?: string): Promise<SignedEnvelope<T>> {
    const envelope = this.identity.sign(topic, payload, recipient === undefined ? {} : { recipient });
    await this.transport.send(address, Buffer.from(JSON.stringify(envelope), "utf8"));
    return envelope;
  }

  close(): void {
    this.#unsubscribe();
    this.#handlers.clear();
  }
}
