import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, hashValue } from "../dist/lab/canonical.js";
import { LabEventRecorder } from "../dist/lab/event-recorder.js";
import { verifyEventChain } from "../dist/lab/events.js";
import { deterministicId } from "../dist/lab/ids.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { DeterministicRng } from "../dist/lab/rng.js";

const manifest = {
  schemaVersion: 1,
  experimentId: "genesis-1",
  engineVersion: "genesis-logical-v1.0.0",
  mode: "logical",
  policyId: "neutral-backpressure-v1",
  taskGeneratorId: "deterministic-task-stream-v1",
  runId: "run:test",
  universeId: "U0001",
  seed: "test-seed",
  configHash: "a".repeat(64),
};

const resources = (credits) => ({
  credits,
  llmTokens: 100,
  computeMs: 100,
  storageBytes: 100,
  bandwidthBytes: 100,
});

const drafts = [
  { tick: 0, phase: "genesis", type: "run.started", data: { treasury: resources(1000) } },
  {
    tick: 0,
    phase: "genesis",
    type: "agent.created",
    actorId: "agent:A",
    data: {
      agent: {
        id: "agent:A",
        active: true,
        generation: 0,
        lineage: [],
        resources: resources(100),
        memory: {},
        learning: { attempts: {}, successes: {}, utilityPpm: {} },
        actionCounts: {},
        taskCounts: {},
        violations: 0,
        createdTick: 0,
      },
    },
  },
  {
    tick: 1,
    phase: "resolution",
    type: "resource.spent",
    actorId: "agent:A",
    data: { agentId: "agent:A", resource: "credits", amount: 10 },
  },
  { tick: 1, phase: "upkeep", type: "tick.completed", data: {} },
  { tick: 2, phase: "completion", type: "run.completed", data: {} },
];

test("canonical JSON, IDs, and forked RNG streams are deterministic", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(deterministicId("agent", "run", 1), deterministicId("agent", "run", 1));
  assert.notEqual(deterministicId("agent", "run", 1), deterministicId("agent", "run", 2));

  const left = new DeterministicRng("root");
  const right = new DeterministicRng("root");
  assert.deepEqual(Array.from({ length: 20 }, () => left.nextInt(10_000)), Array.from({ length: 20 }, () => right.nextInt(10_000)));
  const consumed = new DeterministicRng("fork-root");
  consumed.nextInt(100);
  assert.deepEqual(consumed.fork("agent-1").shuffle([1, 2, 3, 4]), new DeterministicRng("fork-root").fork("agent-1").shuffle([1, 2, 3, 4]));
});

test("recorders produce byte-identical canonical hash-chained JSONL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-determinism-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstPath = join(directory, "first.jsonl");
  const secondPath = join(directory, "second.jsonl");
  const first = await LabEventRecorder.open(firstPath, manifest);
  const second = await LabEventRecorder.open(secondPath, manifest);
  for (const draft of drafts) {
    await first.append(draft);
    await second.append(structuredClone(draft));
  }
  await Promise.all([first.flush(), second.flush()]);

  assert.equal(await readFile(firstPath, "utf8"), await readFile(secondPath, "utf8"));
  assert.deepEqual(first.events(), second.events());
  assert.equal(verifyEventChain(first.events(), manifest).lastHash, first.lastHash);
});

test("single recorder serializes concurrent append requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = await LabEventRecorder.open(join(directory, "events.jsonl"), manifest);
  await Promise.all(Array.from({ length: 32 }, (_, tick) => recorder.append({
    tick,
    phase: "upkeep",
    type: "tick.completed",
    data: { tick },
  })));
  const events = recorder.events();
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 32 }, (_, index) => index + 1));
  assert.equal(verifyEventChain(events, manifest).events, 32);
});

test("tampering and truncated JSONL are rejected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-tamper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const recorder = await LabEventRecorder.open(path, manifest);
  await recorder.append(drafts[0]);
  await recorder.append(drafts[1]);
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace('"tick":0', '"tick":1'), "utf8");
  await assert.rejects(LabEventRecorder.open(path, manifest), /hash mismatch|logical time|previousHash/);
  await writeFile(path, original.slice(0, -1), "utf8");
  await assert.rejects(LabEventRecorder.open(path, manifest), /truncated/);
});

test("replay is a pure event projection and returns a stable state digest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = await LabEventRecorder.open(join(directory, "events.jsonl"), manifest);
  for (const draft of drafts) await recorder.append(draft);

  const before = structuredClone(recorder.events());
  const complete = ReplayEngine.replay(before, manifest);
  assert.equal(complete.state.agents["agent:A"].resources.credits, 90);
  assert.equal(complete.state.completed, true);
  assert.equal(complete.digest, hashValue(complete.state));
  assert.equal(complete.finalEventHash, recorder.lastHash);
  assert.deepEqual(recorder.events(), before);

  const partial = ReplayEngine.replay(before, manifest, 1);
  assert.equal(partial.state.tick, 1);
  assert.equal(partial.state.completed, false);
  assert.equal(partial.state.agents["agent:A"].resources.credits, 90);
  assert.notEqual(partial.digest, complete.digest);
});
