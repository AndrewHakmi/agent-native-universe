import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createLabEvent,
  deserializeEventJsonl,
  initialEventHash,
  serializeLabEvent,
  verifyEventChain,
} from "./events.js";
import type { LabEvent, LabEventDraft, RunManifest } from "./types.js";

/** Append-only JSONL recorder. All appends on one instance pass through one queue. */
export class LabEventRecorder {
  readonly manifest: RunManifest;
  readonly path: string;
  #recorded: LabEvent[];
  #lastHash: string;
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, manifest: RunManifest, events: LabEvent[]) {
    this.path = path;
    this.manifest = structuredClone(manifest);
    this.#recorded = structuredClone(events);
    this.#lastHash = events.at(-1)?.hash ?? initialEventHash(manifest);
  }

  static async open(path: string, manifest: RunManifest): Promise<LabEventRecorder> {
    if (path.length === 0) throw new TypeError("Event log path must not be empty");
    await mkdir(dirname(path), { recursive: true });
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await appendFile(path, "", "utf8");
      text = "";
    }
    const events = deserializeEventJsonl(text);
    verifyEventChain(events, manifest);
    return new LabEventRecorder(path, manifest, events);
  }

  get lastHash(): string {
    return this.#lastHash;
  }

  get lastSeq(): number {
    return this.#recorded.length;
  }

  append(draft: LabEventDraft): Promise<LabEvent> {
    const captured = structuredClone(draft);
    const operation = this.#tail.then(async () => {
      const event = createLabEvent(this.manifest, captured, this.#recorded.length + 1, this.#lastHash);
      await appendFile(this.path, `${serializeLabEvent(event)}\n`, "utf8");
      this.#recorded.push(event);
      this.#lastHash = event.hash;
      return structuredClone(event);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  events(): LabEvent[] {
    return structuredClone(this.#recorded);
  }

  async flush(): Promise<void> {
    await this.#tail;
    const handle = await open(this.path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
