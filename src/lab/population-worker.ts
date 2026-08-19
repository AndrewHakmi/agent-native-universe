#!/usr/bin/env node
import {
  GenesisRunPausedError,
  runGenesis,
  type GenesisRunOptions,
} from "./genesis.js";

let controller: AbortController | undefined;
let started = false;

process.on("message", (message: unknown) => {
  if (message === null || typeof message !== "object") return;
  const candidate = message as Record<string, unknown>;
  if (candidate.type === "cancel") {
    controller?.abort();
    return;
  }
  if (candidate.type !== "run" || started) return;
  started = true;
  controller = new AbortController();
  void execute(candidate.options, controller.signal);
});

process.once("SIGINT", () => controller?.abort());
process.once("SIGTERM", () => controller?.abort());

async function execute(value: unknown, signal: AbortSignal): Promise<void> {
  try {
    const options = parseOptions(value, signal);
    const summary = await runGenesis(options);
    await send({ type: "summary", summary });
  } catch (error) {
    if (error instanceof GenesisRunPausedError) {
      await send({
        type: "paused",
        runId: error.runId,
        universeId: error.universeId,
        tick: error.tick,
      });
    } else {
      await send({
        type: "error",
        name: error instanceof Error ? error.name.slice(0, 128) : "Error",
        message: error instanceof Error ? error.message.slice(0, 1_024) : "Unknown worker failure",
      });
    }
  } finally {
    process.disconnect?.();
  }
}

function send(message: unknown): Promise<void> {
  return new Promise((resolveSend, rejectSend) => {
    if (process.send === undefined) {
      rejectSend(new Error("Population worker requires an IPC channel"));
      return;
    }
    process.send(message, (error) => error ? rejectSend(error) : resolveSend());
  });
}

function parseOptions(value: unknown, signal: AbortSignal): GenesisRunOptions {
  if (value === null || typeof value !== "object") throw new Error("Worker options must be an object");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.config === null
    || typeof candidate.config !== "object"
    || typeof candidate.runsRoot !== "string"
    || typeof candidate.universeId !== "string"
  ) {
    throw new Error("Worker options are malformed");
  }
  return {
    config: structuredClone(candidate.config) as GenesisRunOptions["config"],
    runsRoot: candidate.runsRoot,
    universeId: candidate.universeId,
    signal,
  };
}
