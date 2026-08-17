import { hashValue } from "./canonical.js";
import { iterateEventFile } from "./event-stream.js";
import {
  initialEventChainVerification,
  initialEventHash,
  verifyNextEvent,
} from "./events.js";
import { assertLabManifestImplementation } from "./manifest.js";
import { LabProtocolVerifier } from "./protocol-verifier.js";
import { applyWorldEventMutable, initialWorldState } from "./reducer.js";
import type { GenesisConfig, LabEvent, RunManifest, WorldState } from "./types.js";

export interface ReplayResult {
  state: WorldState;
  digest: string;
  stateHash: string;
  finalEventHash: string;
  eventsApplied: number;
  lastSeq: number;
  lastTick: number;
}

/** Replay verifies the complete deterministic protocol before returning its projection. */
export class ReplayEngine {
  static replay(
    events: readonly LabEvent[],
    manifest: RunManifest,
    config: GenesisConfig,
    untilTick?: number,
  ): ReplayResult {
    assertLabManifestImplementation(manifest);
    validateUntilTick(untilTick);
    const protocol = new LabProtocolVerifier(manifest, config);
    let verification = initialEventChainVerification(manifest);
    const state = initialWorldState(manifest);
    let outputState: WorldState | undefined;
    let eventsApplied = 0;
    let finalEventHash = initialEventHash(manifest);
    let lastSeq = 0;

    for (const event of events) {
      verification = verifyNextEvent(event, manifest, verification);
      if (untilTick !== undefined && event.tick > untilTick && outputState === undefined) {
        outputState = structuredClone(state);
      }
      protocol.verifyNext(event, state);
      applyWorldEventMutable(state, event);
      if (untilTick === undefined || event.tick <= untilTick) {
        eventsApplied += 1;
        finalEventHash = event.hash;
        lastSeq = event.seq;
      }
    }
    protocol.finish();

    const projected = outputState ?? state;
    const digest = hashValue(projected);
    return {
      state: projected,
      digest,
      stateHash: digest,
      finalEventHash,
      eventsApplied,
      lastSeq,
      lastTick: projected.tick,
    };
  }

  static async replayFile(
    path: string,
    manifest: RunManifest,
    config: GenesisConfig,
    untilTick?: number,
  ): Promise<ReplayResult> {
    assertLabManifestImplementation(manifest);
    validateUntilTick(untilTick);
    const protocol = new LabProtocolVerifier(manifest, config);
    let verification = initialEventChainVerification(manifest);
    const state = initialWorldState(manifest);
    let outputState: WorldState | undefined;
    let eventsApplied = 0;
    let finalEventHash = initialEventHash(manifest);
    let lastSeq = 0;

    for await (const event of iterateEventFile(path)) {
      verification = verifyNextEvent(event, manifest, verification);
      if (untilTick !== undefined && event.tick > untilTick && outputState === undefined) {
        outputState = structuredClone(state);
      }
      protocol.verifyNext(event, state);
      applyWorldEventMutable(state, event);
      if (untilTick === undefined || event.tick <= untilTick) {
        eventsApplied += 1;
        finalEventHash = event.hash;
        lastSeq = event.seq;
      }
    }
    protocol.finish();

    const projected = outputState ?? state;
    const digest = hashValue(projected);
    return {
      state: projected,
      digest,
      stateHash: digest,
      finalEventHash,
      eventsApplied,
      lastSeq,
      lastTick: projected.tick,
    };
  }
}

export function replayEvents(
  events: readonly LabEvent[],
  manifest: RunManifest,
  config: GenesisConfig,
  untilTick?: number,
): ReplayResult {
  return ReplayEngine.replay(events, manifest, config, untilTick);
}

function validateUntilTick(untilTick: number | undefined): void {
  if (untilTick !== undefined && (!Number.isSafeInteger(untilTick) || untilTick < 0)) {
    throw new RangeError("untilTick must be a non-negative safe integer");
  }
}
