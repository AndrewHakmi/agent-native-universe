import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { canonicalJson, MeshIdentity, randomToken, validateMeshPublicIdentity, verifyMeshSignature } from "./identity.js";
import type { JsonObject, JsonValue, MeshPeer, MeshPublicIdentity, NetworkAddress } from "./types.js";

interface EnvelopeHeader {
  version: 2;
  id: string;
  sender: string;
  recipient: string;
  topic: string;
  timestamp: number;
  nonce: string;
  ephemeralPublicKeyPem: string;
  iv: string;
  senderIdentity: MeshPublicIdentity;
}

export interface EncryptedEnvelope extends EnvelopeHeader {
  ciphertext: string;
  authTag: string;
  signature: string;
}

export interface DecryptedMeshMessage<T extends JsonValue = JsonValue> {
  envelope: EncryptedEnvelope;
  topic: string;
  sender: string;
  recipient: string;
  payload: T;
  remote: NetworkAddress;
}

export class MeshIdentityRegistry {
  readonly #identities = new Map<string, MeshPublicIdentity>();

  register(identity: MeshPublicIdentity): void {
    const existing = this.#identities.get(identity.id);
    if (
      existing
      && (
        existing.signingFingerprint !== identity.signingFingerprint
        || existing.encryptionFingerprint !== identity.encryptionFingerprint
      )
    ) {
      throw new Error(`Identity substitution attempted for ${identity.id}`);
    }
    if (!validateMeshPublicIdentity(identity)) throw new Error(`Invalid public identity ${identity.id}`);
    this.#identities.set(identity.id, structuredClone(identity));
  }

  get(id: string): MeshPublicIdentity | undefined {
    const identity = this.#identities.get(id);
    return identity ? structuredClone(identity) : undefined;
  }

  values(): MeshPublicIdentity[] {
    return [...this.#identities.values()].map((identity) => structuredClone(identity));
  }
}

export class NonceWindow {
  readonly #seen = new Map<string, number>();

  constructor(readonly ttlMs = 5 * 60_000, readonly maxEntries = 100_000) {}

  accept(sender: string, nonce: string, now = Date.now()): boolean {
    this.prune(now);
    const key = `${sender}:${nonce}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now + this.ttlMs);
    while (this.#seen.size > this.maxEntries) {
      const first = this.#seen.keys().next().value as string | undefined;
      if (!first) break;
      this.#seen.delete(first);
    }
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, expiresAt] of this.#seen) if (expiresAt <= now) this.#seen.delete(key);
  }
}

function keyMaterial(secret: Buffer, envelopeId: string, sender: string, recipient: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    secret,
    Buffer.from(envelopeId, "utf8"),
    Buffer.from(`agent-native-universe:v2:${sender}:${recipient}`, "utf8"),
    32,
  ));
}

function aadFor(header: EnvelopeHeader): Buffer {
  return Buffer.from(canonicalJson(header as unknown as JsonValue), "utf8");
}

function signedBody(envelope: Omit<EncryptedEnvelope, "signature">): JsonValue {
  return envelope as unknown as JsonValue;
}

export class EncryptedEnvelopeCodec {
  constructor(
    readonly identity: MeshIdentity,
    readonly registry: MeshIdentityRegistry,
    readonly nonces = new NonceWindow(),
  ) {
    this.registry.register(identity.publicIdentity());
  }

  seal<T extends JsonValue>(recipient: MeshPublicIdentity, topic: string, payload: T, now = Date.now()): EncryptedEnvelope {
    this.registry.register(recipient);
    const ephemeral = generateKeyPairSync("x25519");
    const ephemeralPublicKeyPem = ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString();
    const id = randomUUID();
    const header: EnvelopeHeader = {
      version: 2,
      id,
      sender: this.identity.id,
      recipient: recipient.id,
      topic,
      timestamp: now,
      nonce: randomToken(),
      ephemeralPublicKeyPem,
      iv: randomBytes(12).toString("base64"),
      senderIdentity: this.identity.publicIdentity(),
    };
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: createPublicKey(recipient.encryptionPublicKeyPem),
    });
    const key = keyMaterial(shared, id, header.sender, header.recipient);
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
    cipher.setAAD(aadFor(header));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(payload), "utf8")),
      cipher.final(),
    ]);
    const unsigned: Omit<EncryptedEnvelope, "signature"> = {
      ...header,
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
    return { ...unsigned, signature: this.identity.sign(signedBody(unsigned)) };
  }

  open<T extends JsonValue>(envelope: EncryptedEnvelope, options: { now?: number; maxClockSkewMs?: number } = {}): T {
    const now = options.now ?? Date.now();
    if (envelope.version !== 2) throw new Error("Unsupported encrypted envelope version");
    if (envelope.recipient !== this.identity.id) throw new Error("Encrypted envelope addressed to another recipient");
    if (Math.abs(now - envelope.timestamp) > (options.maxClockSkewMs ?? 60_000)) throw new Error("Encrypted envelope timestamp outside accepted window");
    this.registry.register(envelope.senderIdentity);
    const trusted = this.registry.get(envelope.sender);
    if (!trusted) throw new Error(`Unknown encrypted-envelope sender ${envelope.sender}`);
    if (
      trusted.signingFingerprint !== envelope.senderIdentity.signingFingerprint
      || trusted.encryptionFingerprint !== envelope.senderIdentity.encryptionFingerprint
    ) {
      throw new Error("Encrypted-envelope identity mismatch");
    }
    const { signature, ...unsigned } = envelope;
    if (!verifyMeshSignature(trusted, signedBody(unsigned), signature)) throw new Error("Encrypted-envelope signature invalid");
    if (!this.nonces.accept(envelope.sender, envelope.nonce, now)) throw new Error("Encrypted-envelope replay detected");

    const shared = this.identity.deriveSharedSecret(envelope.ephemeralPublicKeyPem);
    const key = keyMaterial(shared, envelope.id, envelope.sender, envelope.recipient);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    const header: EnvelopeHeader = {
      version: envelope.version,
      id: envelope.id,
      sender: envelope.sender,
      recipient: envelope.recipient,
      topic: envelope.topic,
      timestamp: envelope.timestamp,
      nonce: envelope.nonce,
      ephemeralPublicKeyPem: envelope.ephemeralPublicKeyPem,
      iv: envelope.iv,
      senderIdentity: envelope.senderIdentity,
    };
    decipher.setAAD(aadFor(header));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }
}

export type MeshMessageHandler = (message: DecryptedMeshMessage) => void | Promise<void>;

export class EncryptedTcpTransport {
  readonly codec: EncryptedEnvelopeCodec;
  readonly #handlers = new Set<MeshMessageHandler>();
  readonly #rawObservers = new Set<(bytes: Uint8Array, direction: "in" | "out") => void>();
  #server: Server | undefined;
  #address: NetworkAddress | undefined;

  constructor(
    identity: MeshIdentity,
    registry = new MeshIdentityRegistry(),
    readonly options: { maxFrameBytes?: number; connectTimeoutMs?: number } = {},
  ) {
    this.codec = new EncryptedEnvelopeCodec(identity, registry);
  }

  get identity(): MeshIdentity {
    return this.codec.identity;
  }

  get registry(): MeshIdentityRegistry {
    return this.codec.registry;
  }

  get address(): NetworkAddress {
    if (!this.#address) throw new Error("Encrypted transport has not been started");
    return { ...this.#address };
  }

  addPeer(identity: MeshPublicIdentity): void {
    this.registry.register(identity);
  }

  onMessage(handler: MeshMessageHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  observeRawFrames(observer: (bytes: Uint8Array, direction: "in" | "out") => void): () => void {
    this.#rawObservers.add(observer);
    return () => this.#rawObservers.delete(observer);
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
    if (!bound || typeof bound === "string") throw new Error("Encrypted TCP server did not expose an IP address");
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

  async send<T extends JsonValue>(peer: MeshPeer, topic: string, payload: T): Promise<EncryptedEnvelope> {
    this.registry.register(peer.identity);
    const envelope = this.codec.seal(peer.identity, topic, payload);
    const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
    for (const observer of this.#rawObservers) observer(bytes, "out");
    await this.#sendFrame(peer.address, bytes);
    return envelope;
  }

  async #sendFrame(address: NetworkAddress, bytes: Buffer): Promise<void> {
    const max = this.options.maxFrameBytes ?? 8 * 1024 * 1024;
    if (bytes.byteLength > max) throw new Error(`Encrypted frame exceeds ${max} bytes`);
    const frame = Buffer.allocUnsafe(4 + bytes.byteLength);
    frame.writeUInt32BE(bytes.byteLength, 0);
    bytes.copy(frame, 4);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(address);
      const timer = setTimeout(
        () => socket.destroy(new Error("Encrypted TCP connect timeout")),
        this.options.connectTimeoutMs ?? 5_000,
      );
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end(frame, resolve);
      });
    });
  }

  #accept(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    const remote = { host: socket.remoteAddress ?? "unknown", port: socket.remotePort ?? 0 };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) {
          socket.destroy(new Error("Incoming encrypted frame is too large"));
          return;
        }
        if (buffer.length < 4 + size) return;
        const bytes = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        for (const observer of this.#rawObservers) observer(bytes, "in");
        void this.#dispatch(bytes, remote);
      }
    });
  }

  async #dispatch(bytes: Buffer, remote: NetworkAddress): Promise<void> {
    try {
      const envelope = JSON.parse(bytes.toString("utf8")) as EncryptedEnvelope;
      const payload = this.codec.open(envelope);
      const message: DecryptedMeshMessage = {
        envelope,
        topic: envelope.topic,
        sender: envelope.sender,
        recipient: envelope.recipient,
        payload,
        remote,
      };
      await Promise.allSettled([...this.#handlers].map((handler) => handler(message)));
    } catch {
      // Invalid, replayed, tampered, stale, or undecryptable frames are dropped.
    }
  }
}
