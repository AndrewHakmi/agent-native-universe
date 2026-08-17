import { constants } from "node:fs";
import { dirname } from "node:path";
import {
  createLabEvent,
  initialEventChainVerification,
  MAX_LAB_EVENT_BYTES,
  serializeLabEvent,
  verifyNextEvent,
} from "./events.js";
import {
  ensureNoSymlinkDirectoryHierarchy,
  openRegularFileNoFollow,
  scanEventFile,
} from "./event-stream.js";
import type { LabEvent, LabEventDraft, RunManifest } from "./types.js";

export interface LabEventRecorderOptions {
  /** Keep an in-memory copy for synchronous `events()` compatibility. */
  retainEvents?: boolean;
}

/** Append-only JSONL recorder. All appends on one instance pass through one queue. */
export class LabEventRecorder {
  readonly manifest: RunManifest;
  readonly path: string;
  #recorded: LabEvent[] | undefined;
  #lastHash: string;
  #lastSeq: number;
  #lastTick: number;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    path: string,
    manifest: RunManifest,
    lastSeq: number,
    lastTick: number,
    lastHash: string,
    events: LabEvent[] | undefined,
  ) {
    this.path = path;
    this.manifest = structuredClone(manifest);
    this.#recorded = events === undefined ? undefined : structuredClone(events);
    this.#lastSeq = lastSeq;
    this.#lastTick = lastTick;
    this.#lastHash = lastHash;
  }

  static async open(
    path: string,
    manifest: RunManifest,
    options: LabEventRecorderOptions = {},
  ): Promise<LabEventRecorder> {
    if (path.length === 0) throw new TypeError("Event log path must not be empty");
    await ensureNoSymlinkDirectoryHierarchy(dirname(path));
    const createHandle = await openRegularFileNoFollow(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
    );
    await createHandle.close();

    const retained = options.retainEvents === false ? undefined : [] as LabEvent[];
    const verification = await scanEventFile(path, manifest, (event) => {
      retained?.push(event);
    });
    return new LabEventRecorder(
      path,
      manifest,
      verification.lastSeq,
      verification.lastTick,
      verification.lastHash,
      retained,
    );
  }

  get retainsEvents(): boolean {
    return this.#recorded !== undefined;
  }

  get lastHash(): string {
    return this.#lastHash;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get lastTick(): number {
    return this.#lastTick;
  }

  append(draft: LabEventDraft): Promise<LabEvent> {
    const captured = structuredClone(draft);
    return this.#enqueue(async () => {
      const event = createLabEvent(this.manifest, captured, this.#lastSeq + 1, this.#lastHash);
      return this.#writeVerified(event);
    });
  }

  /**
   * Append a pre-created event only if it is still the exact next chain item.
   * Stale previews fail before any bytes are written.
   */
  appendPrepared(event: LabEvent): Promise<LabEvent> {
    const captured = structuredClone(event);
    return this.#enqueue(() => this.#writeVerified(captured));
  }

  events(): LabEvent[] {
    if (this.#recorded === undefined) {
      throw new Error(
        "This recorder was opened with retainEvents=false; use ReplayEngine.replayFile() or iterateEventFile()",
      );
    }
    return structuredClone(this.#recorded);
  }

  async flush(): Promise<void> {
    await this.#tail;
    await ensureNoSymlinkDirectoryHierarchy(dirname(this.path));
    const handle = await openRegularFileNoFollow(this.path, constants.O_RDWR);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #enqueue(operation: () => Promise<LabEvent>): Promise<LabEvent> {
    const queued = this.#tail.then(operation);
    this.#tail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async #writeVerified(event: LabEvent): Promise<LabEvent> {
    const previous = this.#lastSeq === 0
      ? initialEventChainVerification(this.manifest)
      : {
          events: this.#lastSeq,
          lastSeq: this.#lastSeq,
          lastTick: this.#lastTick,
          lastHash: this.#lastHash,
    };
    const verification = verifyNextEvent(event, this.manifest, previous);
    const serialized = serializeLabEvent(event);
    if (Buffer.byteLength(serialized, "utf8") > MAX_LAB_EVENT_BYTES) {
      throw new Error(`Event ${event.seq} exceeds the ${MAX_LAB_EVENT_BYTES}-byte limit`);
    }
    await ensureNoSymlinkDirectoryHierarchy(dirname(this.path));
    const handle = await openRegularFileNoFollow(
      this.path,
      constants.O_WRONLY | constants.O_APPEND,
    );
    try {
      await handle.writeFile(`${serialized}\n`, "utf8");
    } finally {
      await handle.close();
    }
    this.#recorded?.push(event);
    this.#lastSeq = verification.lastSeq;
    this.#lastTick = verification.lastTick;
    this.#lastHash = verification.lastHash;
    return structuredClone(event);
  }
}
