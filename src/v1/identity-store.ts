import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CryptoIdentity } from "./security-transport.js";

interface StoredIdentity {
  format: 1;
  id: string;
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: number;
}

export class IdentityFileStore {
  constructor(readonly path: string) {}

  async load(): Promise<CryptoIdentity> {
    const stored = JSON.parse(await readFile(this.path, "utf8")) as StoredIdentity;
    if (stored.format !== 1 || !stored.id || !stored.privateKeyPem || !stored.publicKeyPem) throw new Error("Invalid identity file");
    return CryptoIdentity.fromPem(stored.id, stored.privateKeyPem, stored.publicKeyPem);
  }

  async create(id = `node:${randomUUID()}`): Promise<CryptoIdentity> {
    const identity = CryptoIdentity.generate(id);
    const stored: StoredIdentity = {
      format: 1,
      id: identity.id,
      privateKeyPem: identity.exportPrivateKeyPem(),
      publicKeyPem: identity.publicKeyPem,
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

  async loadOrCreate(id?: string): Promise<CryptoIdentity> {
    try {
      return await this.load();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      return this.create(id);
    }
  }
}
