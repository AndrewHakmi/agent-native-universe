import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { LabEventRecorder } from "../dist/lab/event-recorder.js";
import {
  createLabEvent,
  deserializeEventJsonl,
  initialEventHash,
  MAX_LAB_EVENT_BYTES,
  serializeLabEvent,
} from "../dist/lab/events.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import { ReplayEngine } from "../dist/lab/replay.js";

function fixture() {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = "event-boundaries";
  return { config, manifest: createRunManifest(config, "U0001") };
}

test("all event writers and readers share one canonical byte bound", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-event-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const { manifest } = fixture();
  const draft = {
    tick: 0,
    phase: "genesis",
    type: "run.started",
    data: { payload: "x".repeat(MAX_LAB_EVENT_BYTES) },
  };
  const oversized = createLabEvent(manifest, draft, 1, initialEventHash(manifest));

  assert.throws(() => serializeLabEvent(oversized), /byte limit/);
  const recorder = await LabEventRecorder.open(path, manifest);
  await assert.rejects(recorder.append(draft), /byte limit/);
  assert.equal(await readFile(path, "utf8"), "", "rejected events must not write a partial record");
});

test("array and streaming readers reject hash-valid but non-canonical JSONL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-event-canonical-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const { config, manifest } = fixture();
  const event = createLabEvent(
    manifest,
    { tick: 0, phase: "genesis", type: "run.started", data: {} },
    1,
    initialEventHash(manifest),
  );
  const nonCanonical = `${JSON.stringify(event).replace("{", "{ ")}\n`;
  await writeFile(path, nonCanonical, "utf8");

  assert.throws(() => deserializeEventJsonl(nonCanonical), /not canonical JSON/);
  await assert.rejects(ReplayEngine.replayFile(path, manifest, config), /not canonical JSON/);
});

test("streaming event readers reject invalid UTF-8 bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-event-utf8-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const { config, manifest } = fixture();
  const event = createLabEvent(
    manifest,
    { tick: 0, phase: "genesis", type: "run.started", data: { marker: "\uFFFD" } },
    1,
    initialEventHash(manifest),
  );
  const valid = Buffer.from(`${serializeLabEvent(event)}\n`, "utf8");
  const replacement = Buffer.from("\uFFFD", "utf8");
  const replacementOffset = valid.indexOf(replacement);
  assert.ok(replacementOffset >= 0);
  const corrupted = Buffer.concat([
    valid.subarray(0, replacementOffset),
    Buffer.from([0xff]),
    valid.subarray(replacementOffset + replacement.length),
  ]);
  await writeFile(path, corrupted);

  await assert.rejects(ReplayEngine.replayFile(path, manifest, config), /not valid UTF-8/);
  await assert.rejects(LabEventRecorder.open(path, manifest), /not valid UTF-8/);
});
