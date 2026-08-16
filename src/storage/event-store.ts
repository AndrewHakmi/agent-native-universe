import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonObject } from "../core/types.js";
export interface StoredEvent { seq: number; at: number; type: string; entityId: string; payload: JsonObject; }
export class JsonlEventStore { #seq = 0; constructor(readonly path: string) {} async init(): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const events = await this.readAll().catch(()=>[]); this.#seq = events.at(-1)?.seq ?? 0; } async append(type: string, entityId: string, payload: JsonObject): Promise<StoredEvent> { const event = { seq: ++this.#seq, at: Date.now(), type, entityId, payload }; await appendFile(this.path, JSON.stringify(event)+"\n", "utf8"); return event; } async readAll(): Promise<StoredEvent[]> { const text = await readFile(this.path, "utf8"); return text.split("\n").filter(Boolean).map(x => JSON.parse(x) as StoredEvent); } }
