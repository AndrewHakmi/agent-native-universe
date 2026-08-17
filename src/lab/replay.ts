import { readFile } from "node:fs/promises";
import { hashValue } from "./canonical.js";
import { deserializeEventJsonl, initialEventHash, verifyEventChain } from "./events.js";
import { initialWorldState, reduceWorldEvent } from "./reducer.js";
import type { LabEvent, RunManifest, WorldState } from "./types.js";

export interface ReplayResult {
  state: WorldState;
  digest: string;
  stateHash: string;
  finalEventHash: string;
  eventsApplied: number;
  lastSeq: number;
  lastTick: number;
}

/** Replay is deliberately projection-only: it imports neither policy nor evaluator. */
export class ReplayEngine {
  static replay(events: readonly LabEvent[], manifest: RunManifest, untilTick?: number): ReplayResult {
    if (untilTick !== undefined && (!Number.isSafeInteger(untilTick) || untilTick < 0)) {
      throw new RangeError("untilTick must be a non-negative safe integer");
    }
    verifyEventChain(events, manifest);
    let state = initialWorldState(manifest);
    let eventsApplied = 0;
    let finalEventHash = initialEventHash(manifest);
    let lastSeq = 0;

    for (const event of events) {
      if (untilTick !== undefined && event.tick > untilTick) break;
      state = reduceWorldEvent(state, event);
      eventsApplied += 1;
      finalEventHash = event.hash;
      lastSeq = event.seq;
    }

    const digest = hashValue(state);
    return {
      state,
      digest,
      stateHash: digest,
      finalEventHash,
      eventsApplied,
      lastSeq,
      lastTick: state.tick,
    };
  }

  static async replayFile(path: string, manifest: RunManifest, untilTick?: number): Promise<ReplayResult> {
    const events = deserializeEventJsonl(await readFile(path, "utf8"));
    return ReplayEngine.replay(events, manifest, untilTick);
  }
}

export function replayEvents(events: readonly LabEvent[], manifest: RunManifest, untilTick?: number): ReplayResult {
  return ReplayEngine.replay(events, manifest, untilTick);
}
