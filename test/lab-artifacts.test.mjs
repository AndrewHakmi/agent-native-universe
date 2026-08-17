import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceConflictError, EvidenceStore } from "../dist/lab/artifacts.js";
import { canonicalJson, hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { LAB_SCHEMA_VERSION } from "../dist/lab/types.js";

const zeroResources = () => ({
  credits: 0,
  llmTokens: 0,
  computeMs: 0,
  storageBytes: 0,
  bandwidthBytes: 0,
});

function fixture() {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  const manifest = {
    schemaVersion: LAB_SCHEMA_VERSION,
    experimentId: config.experimentId,
    engineVersion: "genesis-logical-v1.0.0",
    mode: "logical",
    policyId: "neutral-backpressure-v1",
    taskGeneratorId: "deterministic-task-stream-v1",
    runId: "run:test-001",
    universeId: "U0001",
    seed: config.seed,
    configHash: hashValue(config),
  };
  return { config, manifest };
}

function metric(tick) {
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    tick,
    tasksCreated: tick,
    tasksCompleted: 0,
    taskSuccessRatePpm: 0,
    meanQualityPpm: 0,
    p50LatencyTicks: 0,
    p95LatencyTicks: 0,
    creditsPerAcceptedTaskPpm: 0,
    computePerAcceptedTaskPpm: 0,
    bandwidthPerAcceptedTaskPpm: 0,
    activeAgents: 0,
    activeLinks: 0,
    densityPpm: 0,
    connectedComponents: 0,
    degreeCentralizationPpm: 0,
    resourceGiniPpm: 0,
    meanSpecializationPpm: 0,
    linkTurnover: 0,
    violations: 0,
  };
}

function state(manifest, tick, metrics = []) {
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    configHash: manifest.configHash,
    seed: manifest.seed,
    tick,
    agents: {},
    links: {},
    tasks: {},
    submissions: {},
    capabilities: {},
    physics: {
      resourcePricePpm: {
        credits: 1_000_000,
        llmTokens: 1_000_000,
        computeMs: 1_000_000,
        storageBytes: 1_000_000,
        bandwidthBytes: 1_000_000,
      },
      bandwidthCapacityPpm: 1_000_000,
      taskLoadPpm: 1_000_000,
    },
    treasury: zeroResources(),
    resourceSpent: zeroResources(),
    metrics,
    completed: false,
  };
}

test("EvidenceStore initializes the canonical run layout and reads every artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();
  const store = await EvidenceStore.initialize(runsRoot, manifest, config);
  const expectedDirectory = join(runsRoot, manifest.experimentId, manifest.universeId);
  assert.equal(store.directory, expectedDirectory);
  assert.equal(await readFile(join(expectedDirectory, "manifest.json"), "utf8"), canonicalJson(manifest));
  assert.equal(await readFile(join(expectedDirectory, "config.json"), "utf8"), canonicalJson(config));
  assert.equal(await readFile(join(expectedDirectory, "events.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(expectedDirectory, "metrics.jsonl"), "utf8"), "");
  assert.deepEqual(await store.readManifest(), manifest);
  assert.deepEqual(await store.readConfig(), config);
  assert.equal(await store.readSummary(), undefined);

  await store.events.append({
    tick: 0,
    phase: "genesis",
    type: "run.started",
    data: {},
  });
  const metrics = [metric(1), metric(2), metric(3)];
  await Promise.all(metrics.map((value) => store.appendMetrics(value)));

  const checkpointState = state(manifest, 3, metrics);
  const checkpoint = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    tick: 3,
    seq: store.events.lastSeq,
    eventHash: store.events.lastHash,
    stateHash: hashValue(checkpointState),
    state: checkpointState,
  };
  await store.writeCheckpoint(checkpoint);
  await store.writeCheckpoint(structuredClone(checkpoint));
  const summary = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    seed: manifest.seed,
    ticks: 3,
    events: store.events.lastSeq,
    finalStateHash: checkpoint.stateHash,
    finalEventHash: checkpoint.eventHash,
    latestMetrics: metrics.at(-1),
  };
  await store.writeSummary(summary);
  await store.flush();

  assert.deepEqual(await store.readMetrics(), metrics);
  assert.deepEqual(await store.readCheckpoint(3), checkpoint);
  assert.deepEqual(await store.readCheckpoints(), [checkpoint]);
  assert.deepEqual(await store.readSummary(), summary);
  assert.equal(
    await readFile(join(expectedDirectory, "checkpoints", "3.json"), "utf8"),
    canonicalJson(checkpoint),
  );
  const metricLines = (await readFile(join(expectedDirectory, "metrics.jsonl"), "utf8")).trimEnd().split("\n");
  assert.deepEqual(metricLines, metrics.map((value) => canonicalJson(value)));
  assert.equal((await readdir(expectedDirectory)).some((entry) => entry.includes(".tmp-")), false);

  const resumed = await EvidenceStore.initialize(runsRoot, manifest, config);
  assert.equal(resumed.events.lastSeq, 1);
  assert.deepEqual(await resumed.readMetrics(), metrics);
});

test("EvidenceStore rejects traversal and unsafe run identifiers before writing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-safe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { config, manifest } = fixture();
  assert.throws(() => new EvidenceStore(directory, "../genesis-1", "U0001"), /unsafe/);
  assert.throws(() => new EvidenceStore(directory, "genesis-1", "../../outside"), /unsafe/);
  assert.throws(() => new EvidenceStore(directory, "genesis-1", "U\\outside"), /unsafe/);
  await assert.rejects(
    EvidenceStore.initialize(directory, { ...manifest, runId: "../run" }, config),
    /unsafe/,
  );
  await assert.rejects(
    EvidenceStore.initialize(directory, { ...manifest, configHash: "0".repeat(64) }, config),
    /Config hash mismatch/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("EvidenceStore writer lease excludes concurrent processes and releases cleanly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new EvidenceStore(directory, "genesis-1", "U0001");
  const second = new EvidenceStore(directory, "genesis-1", "U0001");
  const release = await first.acquireWriterLease("run:lease-test");
  await assert.rejects(
    second.acquireWriterLease("run:lease-test"),
    /active or stale writer lease/,
  );
  await release();
  const releaseAgain = await second.acquireWriterLease("run:lease-test");
  await releaseAgain();
});

test("conflicts and failed resumes preserve existing evidence byte-for-byte", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-artifacts-preserve-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runsRoot = join(directory, "runs");
  const { config, manifest } = fixture();
  const store = await EvidenceStore.initialize(runsRoot, manifest, config);
  await store.events.append({ tick: 0, phase: "genesis", type: "run.started", data: {} });
  await store.appendMetrics(metric(1));
  await store.flush();

  const paths = [store.manifestPath, store.configPath, store.eventsPath, store.metricsPath];
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const changedConfig = structuredClone(config);
  changedConfig.ticks += 1;
  const conflictingManifest = {
    ...manifest,
    runId: "run:conflict",
    configHash: hashValue(changedConfig),
  };
  await assert.rejects(
    EvidenceStore.initialize(runsRoot, conflictingManifest, changedConfig),
    EvidenceConflictError,
  );
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);

  await assert.rejects(store.appendMetrics(metric(1)), /does not advance/);
  assert.equal(await readFile(store.metricsPath, "utf8"), before[3]);

  const firstSummary = {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: manifest.runId,
    universeId: manifest.universeId,
    seed: manifest.seed,
    ticks: 1,
    events: 1,
    finalStateHash: "a".repeat(64),
    finalEventHash: store.events.lastHash,
    latestMetrics: metric(1),
  };
  await store.writeSummary(firstSummary);
  await assert.rejects(store.writeSummary({ ...firstSummary, ticks: 2 }), EvidenceConflictError);
  assert.equal(await readFile(store.summaryPath, "utf8"), canonicalJson(firstSummary));
});
