import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signDetached,
  verify as verifyDetached,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue, MeshPublicIdentity } from "./types.js";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
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

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export class MeshIdentity {
  readonly id: string;
  readonly signingPublicKeyPem: string;
  readonly encryptionPublicKeyPem: string;
  readonly signingFingerprint: string;
  readonly encryptionFingerprint: string;
  readonly #signingPrivateKey: KeyObject;
  readonly #signingPublicKey: KeyObject;
  readonly #encryptionPrivateKey: KeyObject;
  readonly #encryptionPublicKey: KeyObject;

  private constructor(
    id: string,
    signingPrivateKey: KeyObject,
    signingPublicKey: KeyObject,
    encryptionPrivateKey: KeyObject,
    encryptionPublicKey: KeyObject,
  ) {
    this.id = id;
    this.#signingPrivateKey = signingPrivateKey;
    this.#signingPublicKey = signingPublicKey;
    this.#encryptionPrivateKey = encryptionPrivateKey;
    this.#encryptionPublicKey = encryptionPublicKey;
    this.signingPublicKeyPem = signingPublicKey.export({ type: "spki", format: "pem" }).toString();
    this.encryptionPublicKeyPem = encryptionPublicKey.export({ type: "spki", format: "pem" }).toString();
    this.signingFingerprint = sha256(signingPublicKey.export({ type: "spki", format: "der" }));
    this.encryptionFingerprint = sha256(encryptionPublicKey.export({ type: "spki", format: "der" }));
  }

  static generate(id = `mesh:${randomUUID()}`): MeshIdentity {
    const signing = generateKeyPairSync("ed25519");
    const encryption = generateKeyPairSync("x25519");
    return new MeshIdentity(id, signing.privateKey, signing.publicKey, encryption.privateKey, encryption.publicKey);
  }

  static fromPem(input: {
    id: string;
    signingPrivateKeyPem: string;
    signingPublicKeyPem: string;
    encryptionPrivateKeyPem: string;
    encryptionPublicKeyPem: string;
  }): MeshIdentity {
    return new MeshIdentity(
      input.id,
      createPrivateKey(input.signingPrivateKeyPem),
      createPublicKey(input.signingPublicKeyPem),
      createPrivateKey(input.encryptionPrivateKeyPem),
      createPublicKey(input.encryptionPublicKeyPem),
    );
  }

  publicIdentity(): MeshPublicIdentity {
    return {
      id: this.id,
      signingPublicKeyPem: this.signingPublicKeyPem,
      encryptionPublicKeyPem: this.encryptionPublicKeyPem,
      signingFingerprint: this.signingFingerprint,
      encryptionFingerprint: this.encryptionFingerprint,
      algorithm: "Ed25519+X25519",
    };
  }

  exportPrivate(): {
    signingPrivateKeyPem: string;
    encryptionPrivateKeyPem: string;
  } {
    return {
      signingPrivateKeyPem: this.#signingPrivateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      encryptionPrivateKeyPem: this.#encryptionPrivateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }

  sign(value: JsonValue): string {
    return signDetached(null, Buffer.from(canonicalJson(value), "utf8"), this.#signingPrivateKey).toString("base64");
  }

  verifyOwn(value: JsonValue, signature: string): boolean {
    return verifyDetached(
      null,
      Buffer.from(canonicalJson(value), "utf8"),
      this.#signingPublicKey,
      Buffer.from(signature, "base64"),
    );
  }

  deriveSharedSecret(peerEncryptionPublicKeyPem: string): Buffer {
    return diffieHellman({
      privateKey: this.#encryptionPrivateKey,
      publicKey: createPublicKey(peerEncryptionPublicKeyPem),
    });
  }
}

export function validateMeshPublicIdentity(identity: MeshPublicIdentity): boolean {
  if (identity.algorithm !== "Ed25519+X25519") return false;
  try {
    const signing = createPublicKey(identity.signingPublicKeyPem);
    const encryption = createPublicKey(identity.encryptionPublicKeyPem);
    const signingFingerprint = sha256(signing.export({ type: "spki", format: "der" }));
    const encryptionFingerprint = sha256(encryption.export({ type: "spki", format: "der" }));
    return signingFingerprint === identity.signingFingerprint && encryptionFingerprint === identity.encryptionFingerprint;
  } catch {
    return false;
  }
}

export function verifyMeshSignature(identity: MeshPublicIdentity, value: JsonValue, signature: string): boolean {
  if (!validateMeshPublicIdentity(identity)) return false;
  try {
    return verifyDetached(
      null,
      Buffer.from(canonicalJson(value), "utf8"),
      createPublicKey(identity.signingPublicKeyPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

interface StoredMeshIdentity {
  format: 1;
  id: string;
  signingPrivateKeyPem: string;
  signingPublicKeyPem: string;
  encryptionPrivateKeyPem: string;
  encryptionPublicKeyPem: string;
  signingFingerprint: string;
  encryptionFingerprint: string;
  createdAt: number;
}

export class MeshIdentityStore {
  constructor(readonly path: string) {}

  async load(): Promise<MeshIdentity> {
    const stored = JSON.parse(await readFile(this.path, "utf8")) as StoredMeshIdentity;
    if (stored.format !== 1 || !stored.id) throw new Error("Invalid mesh identity file");
    const identity = MeshIdentity.fromPem(stored);
    if (
      identity.signingFingerprint !== stored.signingFingerprint
      || identity.encryptionFingerprint !== stored.encryptionFingerprint
    ) {
      throw new Error("Mesh identity fingerprint mismatch");
    }
    return identity;
  }

  async create(id?: string): Promise<MeshIdentity> {
    const identity = MeshIdentity.generate(id);
    const privateKeys = identity.exportPrivate();
    const stored: StoredMeshIdentity = {
      format: 1,
      id: identity.id,
      ...privateKeys,
      signingPublicKeyPem: identity.signingPublicKeyPem,
      encryptionPublicKeyPem: identity.encryptionPublicKeyPem,
      signingFingerprint: identity.signingFingerprint,
      encryptionFingerprint: identity.encryptionFingerprint,
      createdAt: Date.now(),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
    return identity;
  }

  async loadOrCreate(id?: string): Promise<MeshIdentity> {
    try {
      return await this.load();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.create(id);
    }
  }
}
