import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { LabEventRecorder } from "../dist/lab/event-recorder.js";
import { createLabEvent, initialEventHash, verifyEventChain } from "../dist/lab/events.js";
import { deterministicId } from "../dist/lab/ids.js";
import {
  LAB_ENGINE_VERSION,
  createRunManifest,
} from "../dist/lab/manifest.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { DeterministicRng } from "../dist/lab/rng.js";
import { LogicalUniverse } from "../dist/lab/world.js";

const config = structuredClone(DEFAULT_GENESIS_CONFIG);
config.seed = "test-seed";
config.ticks = 6;
config.agents = 3;
config.metricEvery = 2;
config.checkpointEvery = 6;
config.pressures = config.pressures.map((pressure, index) => ({ ...pressure, tick: index + 1 }));
const manifest = createRunManifest(config, "U0001");

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

async function generatedRun(t, label = "generated") {
  const directory = await mkdtemp(join(tmpdir(), `anu-lab-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const recorder = await LabEventRecorder.open(path, manifest);
  const state = await new LogicalUniverse(manifest, config, recorder).run();
  return { path, recorder, state };
}

function rechain(events, mutate, manifestValue = manifest) {
  let previousHash = initialEventHash(manifestValue);
  return events.map((event) => {
    const { schemaVersion, runId, universeId, seq, eventId, previousHash: _previous, hash, ...draft } = event;
    const changed = mutate(structuredClone(draft), event) ?? draft;
    const forged = createLabEvent(manifestValue, changed, seq, previousHash);
    previousHash = forged.hash;
    return forged;
  });
}

function rechainWithout(events, omit) {
  const retained = events.filter((event) => !omit(event));
  let previousHash = initialEventHash(manifest);
  return retained.map((event, index) => {
    const { schemaVersion, runId, universeId, seq, eventId, previousHash: _previous, hash, ...draft } = event;
    if (draft.type === "run.completed") draft.data.events = retained.length;
    const forged = createLabEvent(manifest, draft, index + 1, previousHash);
    previousHash = forged.hash;
    return forged;
  });
}

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

test("replay rejects evidence for a different engine implementation", async () => {
  const unsupported = { ...manifest, engineVersion: "genesis-logical-v1.0.0" };
  assert.throws(() => ReplayEngine.replay([], unsupported, config), /Unsupported lab engineVersion/);
  await assert.rejects(
    ReplayEngine.replayFile("/path-must-not-be-opened/events.jsonl", unsupported, config),
    /Unsupported lab engineVersion/,
  );
  assert.throws(
    () => ReplayEngine.replay([], { ...manifest, seed: {} }, config),
    /seed must be a non-empty string/,
  );
  assert.throws(
    () => ReplayEngine.replay([], manifest, { ...config, seed: "wrong-seed" }),
    /seed does not match config/,
  );
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

test("non-retaining recorder and file replay verify long logs without materializing them", async (t) => {
  const { path, recorder: writer } = await generatedRun(t, "streaming");
  await writer.flush();
  const expected = ReplayEngine.replay(writer.events(), manifest, config);

  const streaming = await LabEventRecorder.open(path, manifest, { retainEvents: false });
  assert.equal(streaming.retainsEvents, false);
  assert.equal(streaming.lastSeq, writer.events().length);
  assert.equal(streaming.lastHash, writer.lastHash);
  assert.throws(() => streaming.events(), /retainEvents=false/);

  const replay = await ReplayEngine.replayFile(path, manifest, config);
  assert.equal(replay.stateHash, expected.stateHash);
  assert.equal(replay.finalEventHash, expected.finalEventHash);
  assert.equal(replay.eventsApplied, expected.eventsApplied);
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
  const { recorder, state } = await generatedRun(t, "replay");

  const before = structuredClone(recorder.events());
  const complete = ReplayEngine.replay(before, manifest, config);
  assert.deepEqual(complete.state, state);
  assert.equal(complete.state.completed, true);
  assert.equal(complete.digest, hashValue(complete.state));
  assert.equal(complete.finalEventHash, recorder.lastHash);
  assert.deepEqual(recorder.events(), before);

  const partial = ReplayEngine.replay(before, manifest, config, 1);
  assert.equal(partial.state.tick, 1);
  assert.equal(partial.state.completed, false);
  assert.notEqual(partial.digest, complete.digest);
});

test("authoritative replay rejects hash-valid forged system events", async (t) => {
  const { recorder } = await generatedRun(t, "forged");
  const events = recorder.events();

  const forgedGenesis = rechain(events, (draft) => {
    if (draft.type === "agent.created" && draft.actorId === "N0001") {
      draft.data.agent.resources.credits += 1;
    }
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(forgedGenesis, manifest, config), /genesis agent differs/);

  const forgedPressure = rechain(events, (draft) => {
    if (draft.type === "pressure.applied" && draft.data.type === "resource_price_multiplier") {
      draft.data.multiplierPpm += 1;
    }
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(forgedPressure, manifest, config), /pressure data differs/);

  const forgedTask = rechain(events, (draft) => {
    if (draft.type === "task.created") draft.data.task.deadlineTick += 1;
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(forgedTask, manifest, config), /generated task differs/);

  const forgedEvaluation = rechain(events, (draft) => {
    if (draft.type === "task.evaluated") draft.data.qualityPpm = draft.data.qualityPpm === 0 ? 1_000_000 : 0;
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(forgedEvaluation, manifest, config), /task evaluation differs/);

  const forgedReward = rechain(events, (draft) => {
    if (draft.type === "resource.transferred" && draft.phase === "evaluation") draft.data.amount += 1;
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(forgedReward, manifest, config), /accepted-task reward differs/);

  const forgedMetrics = rechain(events, (draft) => {
    if (draft.type === "metrics.recorded") draft.data.metrics.activeAgents += 1;
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(forgedMetrics, manifest, config), /metrics snapshot differs/);

  const missingMetric = rechainWithout(
    events,
    (event) => event.type === "metrics.recorded" && event.tick === config.metricEvery,
  );
  assert.throws(() => ReplayEngine.replay(missingMetric, manifest, config), /required metric schedule/);

  const firstTaskId = events.find((event) => event.type === "task.created").data.task.id;
  const missingTask = rechainWithout(
    events,
    (event) => event.type === "task.created" && event.data.task.id === firstTaskId,
  );
  assert.throws(() => ReplayEngine.replay(missingTask, manifest, config), /task generation events are missing/);
});

test("authoritative replay rejects forged phase, payment, violation, and completion causality", async (t) => {
  const { recorder } = await generatedRun(t, "causality-forged");
  const events = recorder.events();

  const badPhase = rechain(events, (draft) => {
    if (draft.type === "tick.completed") draft.phase = "metrics";
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(badPhase, manifest, config), /not valid in phase/);

  const badPayment = rechain(events, (draft) => {
    if (draft.type === "resource.spent") draft.data.cost.credits += 1;
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(badPayment, manifest, config), /resource.spent data differs/);

  const injectedViolation = rechain(events, (draft, event) => {
    if (event.seq === events.find((candidate) => candidate.type === "tick.completed").seq) {
      return {
        tick: draft.tick,
        phase: "resolution",
        type: "violation.recorded",
        actorId: "N0001",
        data: { agentId: "N0001", action: "reason", reason: "fabricated", count: 1 },
      };
    }
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(injectedViolation, manifest, config), /uncaused violation/);

  const badCompletion = rechain(events, (draft) => {
    if (draft.type === "run.completed") draft.data.events -= 1;
    return draft;
  });
  assert.throws(() => ReplayEngine.replay(badCompletion, manifest, config), /run.completed data differs/);

  assert.throws(
    () => ReplayEngine.replay(events.slice(0, config.agents + 1), manifest, config),
    /before run\.completed/,
    "a complete genesis prefix is not a complete run",
  );
  assert.throws(
    () => ReplayEngine.replay(events.slice(0, -1), manifest, config),
    /before run\.completed/,
    "a final tick without run.completed is truncated evidence",
  );

  const claimPayment = events.find((event) => (
    event.type === "resource.spent" && event.data.action === "claimTask"
  ));
  assert.ok(claimPayment, "fixture must contain a neutral-policy claim decision");
  const forgedPolicyDecision = rechain(events, (draft, original) => {
    if (original.seq === claimPayment.seq) draft.data.action = "observe";
    return draft;
  });
  assert.throws(
    () => ReplayEngine.replay(forgedPolicyDecision, manifest, config),
    /deterministic neutral-policy schedule/,
    "a same-cost paid action cannot impersonate the manifest-bound policy decision",
  );
});

test("authoritative replay reproduces exact action failures against agents retired after linking", async (t) => {
  const retiredConfig = structuredClone(DEFAULT_GENESIS_CONFIG);
  retiredConfig.seed = "retired-neighbor-0";
  retiredConfig.ticks = 24;
  retiredConfig.agents = 4;
  retiredConfig.metricEvery = 24;
  retiredConfig.checkpointEvery = 24;
  retiredConfig.taskStream.tasksPerTick = 0;
  retiredConfig.initialResources = {
    credits: 100_000,
    llmTokens: 100_000,
    computeMs: 100_000,
    storageBytes: 100_000,
    bandwidthBytes: 100_000,
  };
  retiredConfig.pressures = [
    { tick: 2, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 1_000_000 },
    { tick: 3, type: "bandwidth_capacity_multiplier", multiplierPpm: 1_000_000 },
    { tick: 4, type: "retire_agent_fraction", fractionPpm: 500_000 },
    { tick: 30, type: "task_load_multiplier", multiplierPpm: 1_000_000 },
  ];
  const retiredManifest = createRunManifest(retiredConfig, "U0001");
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-retired-neighbor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = await LabEventRecorder.open(join(directory, "events.jsonl"), retiredManifest);
  const live = await new LogicalUniverse(retiredManifest, retiredConfig, recorder).run();
  const violation = recorder.events().find((event) => (
    event.type === "violation.recorded" && String(event.data.reason).includes("is not active")
  ));
  assert.ok(violation, "fixture must preserve the deterministic retired-neighbor failure");

  const replay = ReplayEngine.replay(recorder.events(), retiredManifest, retiredConfig);
  assert.deepEqual(replay.state, live);

  const forged = rechain(recorder.events(), (draft, original) => {
    if (original.seq === violation.seq) draft.data.reason = "Target forged is not active";
    return draft;
  }, retiredManifest);
  assert.throws(
    () => ReplayEngine.replay(forged, retiredManifest, retiredConfig),
    /deterministic action violation differs/,
  );
});
