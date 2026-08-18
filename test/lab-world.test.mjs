import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { assertNoOracleLeak } from "../dist/lab/environment.js";
import { LabEventRecorder } from "../dist/lab/event-recorder.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import { RESOURCE_KINDS } from "../dist/lab/resource-physics.js";
import { LogicalUniverse } from "../dist/lab/world.js";

function testConfig(seed) {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = seed;
  config.ticks = 6;
  config.agents = 4;
  config.metricEvery = 1;
  config.checkpointEvery = 2;
  config.taskStream.tasksPerTick = 1;
  config.taskStream.deadlineTicks = 3;
  config.taskStream.maxBacklog = 32;
  config.initialResources = {
    credits: 1_000_000,
    llmTokens: 1_000_000,
    computeMs: 1_000_000,
    storageBytes: 1_000_000,
    bandwidthBytes: 1_000_000,
  };
  config.treasuryResources = {
    credits: 10_000,
    llmTokens: 10_000,
    computeMs: 10_000,
    storageBytes: 10_000,
    bandwidthBytes: 10_000,
  };
  config.pressures = [
    { tick: 1, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 2_000_000 },
    { tick: 2, type: "bandwidth_capacity_multiplier", multiplierPpm: 500_000 },
    { tick: 3, type: "retire_agent_fraction", fractionPpm: 250_000 },
    { tick: 4, type: "task_load_multiplier", multiplierPpm: 2_000_000 },
  ];
  return config;
}

function manifestFor(config) {
  return createRunManifest(config, "U0001");
}

async function runWorld(directory, seed, callbacks = {}) {
  const config = testConfig(seed);
  const manifest = manifestFor(config);
  const path = join(directory, `${seed}.jsonl`);
  const recorder = await LabEventRecorder.open(path, manifest);
  const universe = new LogicalUniverse(manifest, config, recorder, callbacks);
  const state = await universe.run();
  return { config, manifest, path, recorder, universe, state };
}

function resourceTotals(state) {
  const totals = Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, BigInt(state.treasury[kind])]));
  for (const agent of Object.values(state.agents)) {
    for (const kind of RESOURCE_KINDS) totals[kind] += BigInt(agent.resources[kind]);
  }
  return totals;
}

test("same seed yields byte-identical events and final state hash", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-world-determinism-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstDirectory = join(directory, "first");
  const secondDirectory = join(directory, "second");
  const first = await runWorld(firstDirectory, "same-seed");
  const second = await runWorld(secondDirectory, "same-seed");

  assert.equal(await readFile(first.path, "utf8"), await readFile(second.path, "utf8"));
  assert.equal(hashValue(first.state), hashValue(second.state));
  assert.equal(first.recorder.lastHash, second.recorder.lastHash);
  assert.equal(first.state.completed, true);
});

test("different seeds produce different evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-world-seeds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await runWorld(join(directory, "one"), "seed-one");
  const second = await runWorld(join(directory, "two"), "seed-two");
  assert.notEqual(await readFile(first.path, "utf8"), await readFile(second.path, "utf8"));
  assert.notEqual(first.recorder.lastHash, second.recorder.lastHash);
});

test("logical universe refuses nondeterministic run identities and neutral-policy overrides", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-world-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = testConfig("identity-seed");
  const manifest = manifestFor(config);
  const forged = { ...manifest, runId: "run-arbitrary" };
  const forgedRecorder = await LabEventRecorder.open(join(directory, "forged.jsonl"), forged);
  assert.throws(
    () => new LogicalUniverse(forged, config, forgedRecorder),
    /runId is not deterministic/,
  );

  const recorder = await LabEventRecorder.open(join(directory, "override.jsonl"), manifest);
  assert.throws(
    () => new LogicalUniverse(manifest, config, recorder, {
      policy: { id: manifest.policyId, decide: () => [] },
    }),
    /neutral policy cannot be overridden/,
  );
});

test("observations and task events never expose evaluator oracles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-world-oracle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = testConfig("oracle-seed");
  const manifest = manifestFor(config);
  const recorder = await LabEventRecorder.open(join(directory, "events.jsonl"), manifest);
  const universe = new LogicalUniverse(manifest, config, recorder);
  await universe.initialize();
  await universe.tick();

  const observations = universe.lastObservations();
  assert.ok(observations.length > 0);
  for (const observation of observations) assert.doesNotThrow(() => assertNoOracleLeak(observation));
  const taskEvents = recorder.events().filter((event) => event.type === "task.created");
  assert.ok(taskEvents.length > 0);
  for (const event of taskEvents) assert.doesNotThrow(() => assertNoOracleLeak(event.data));

  const external = universe.state();
  external.treasury.credits = 0;
  assert.notEqual(universe.state().treasury.credits, 0, "state() must not expose mutable world state");
});

test("resource totals are conserved and every pressure is one-shot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-world-conservation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metrics = [];
  const checkpoints = [];
  const result = await runWorld(directory, "conservation-seed", {
    onMetrics: (snapshot) => metrics.push(snapshot),
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  const expected = {};
  for (const kind of RESOURCE_KINDS) {
    expected[kind] = BigInt(result.config.treasuryResources[kind])
      + BigInt(result.config.initialResources[kind]) * BigInt(result.config.agents);
  }
  assert.deepEqual(resourceTotals(result.state), expected);

  const pressureEvents = result.recorder.events().filter((event) => event.type === "pressure.applied");
  assert.equal(pressureEvents.length, 4);
  assert.deepEqual(pressureEvents.map((event) => event.data.type), [
    "resource_price_multiplier",
    "bandwidth_capacity_multiplier",
    "retire_agent_fraction",
    "task_load_multiplier",
  ]);
  assert.equal(result.recorder.events().filter((event) => event.type === "agent.retired").length, 1);
  assert.equal(metrics.length, result.config.ticks);
  assert.equal(checkpoints.length, 3);
  for (const checkpoint of checkpoints) {
    assert.equal(checkpoint.stateHash, hashValue(checkpoint.state));
    assert.match(checkpoint.eventHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(checkpoints.at(-1).state.completed, true);
  const completion = result.recorder.events().at(-1);
  assert.equal(completion.type, "run.completed");
  assert.equal(completion.data.events, result.recorder.lastSeq);
});
