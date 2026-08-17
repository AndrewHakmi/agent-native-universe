import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { runGenesis } from "../dist/lab/genesis.js";
import { populationSeed } from "../dist/lab/manifest.js";
import {
  MAX_POPULATION_PARALLELISM,
  PopulationRunError,
  populationSummaryPath,
  runPopulation,
} from "../dist/lab/population.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { PPM } from "../dist/lab/types.js";

function testConfig(seed) {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = seed;
  config.ticks = 6;
  config.agents = 4;
  config.metricEvery = 2;
  config.checkpointEvery = 3;
  config.taskStream.tasksPerTick = 1;
  config.taskStream.deadlineTicks = 4;
  config.taskStream.maxBacklog = 16;
  config.pressures = [
    { tick: 1, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 2 * PPM },
    { tick: 2, type: "bandwidth_capacity_multiplier", multiplierPpm: PPM / 2 },
    { tick: 3, type: "retire_agent_fraction", fractionPpm: PPM / 4 },
    { tick: 4, type: "task_load_multiplier", multiplierPpm: 2 * PPM },
  ];
  return config;
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "anu-lab-population-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Genesis persists metrics and checkpoints, then proves final replay equivalence", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const config = testConfig("genesis-orchestration");
  const summary = await runGenesis({ config, runsRoot, universeId: "U0001" });
  const directory = join(runsRoot, config.experimentId, "U0001");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const replay = await ReplayEngine.replayFile(join(directory, "events.jsonl"), manifest);

  assert.equal(replay.stateHash, summary.finalStateHash);
  assert.equal(replay.finalEventHash, summary.finalEventHash);
  assert.equal(replay.eventsApplied, summary.events);
  assert.equal(replay.state.completed, true);
  assert.equal(summary.ticks, config.ticks);

  const metrics = (await readFile(join(directory, "metrics.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(metrics.map((snapshot) => snapshot.tick), [2, 4, 6]);
  assert.deepEqual(summary.latestMetrics, metrics.at(-1));
  assert.deepEqual((await readdir(join(directory, "checkpoints"))).sort(), ["3.json", "6.json"]);
  assert.equal(
    await readFile(join(directory, "summary.json"), "utf8"),
    canonicalJson(summary),
  );

  const eventEvidence = await readFile(join(directory, "events.jsonl"), "utf8");
  const recovered = await runGenesis({ config, runsRoot, universeId: "U0001" });
  assert.deepEqual(recovered, summary, "completed evidence is an idempotent recovery point");
  assert.equal(
    await readFile(join(directory, "events.jsonl"), "utf8"),
    eventEvidence,
    "recovery must not append a second genesis",
  );
});

test("parallel scheduling cannot change per-universe scientific hashes", async (t) => {
  const root = await temporaryRoot(t);
  const serialRoot = join(root, "serial");
  const parallelRoot = join(root, "parallel");
  const config = testConfig("population-base-seed");

  const serial = await runPopulation({ config, runsRoot: serialRoot, universes: 4, parallel: 1 });
  const parallel = await runPopulation({ config, runsRoot: parallelRoot, universes: 4, parallel: 4 });

  assert.deepEqual(parallel, serial);
  assert.deepEqual(
    serial.universes.map((summary) => summary.universeId),
    ["U0001", "U0002", "U0003", "U0004"],
  );
  for (const summary of serial.universes) {
    assert.equal(summary.seed, populationSeed(config.seed, summary.universeId));
  }
  assert.equal(
    await readFile(populationSummaryPath(serialRoot, config.experimentId), "utf8"),
    canonicalJson(serial),
  );
});

test("a failed population preserves every completed universe evidence directory", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const config = testConfig("population-failure-seed");
  const completed = [];

  const runUniverse = async (options) => {
    const summary = await runGenesis(options);
    completed.push(summary.universeId);
    if (summary.universeId === "U0002") throw new Error("injected post-run failure");
    return summary;
  };

  await assert.rejects(
    runPopulation({ config, runsRoot, universes: 3, parallel: 2, runUniverse }),
    (error) => {
      assert.ok(error instanceof PopulationRunError);
      assert.deepEqual(error.failures.map((failure) => failure.universeId), ["U0002"]);
      return true;
    },
  );
  assert.deepEqual(completed.sort(), ["U0001", "U0002", "U0003"]);
  for (const universeId of completed) {
    const summary = JSON.parse(await readFile(
      join(runsRoot, config.experimentId, universeId, "summary.json"),
      "utf8",
    ));
    assert.equal(summary.universeId, universeId);
  }
  await assert.rejects(
    readFile(populationSummaryPath(runsRoot, config.experimentId), "utf8"),
    (error) => error.code === "ENOENT",
  );
});

test("population rejects unsafe concurrency before creating evidence", async () => {
  const config = testConfig("invalid-parallel");
  await assert.rejects(
    runPopulation({
      config,
      runsRoot: "/tmp/anu-unused-population-root",
      universes: 1,
      parallel: MAX_POPULATION_PARALLELISM + 1,
    }),
    /parallel must be a positive safe integer/,
  );
});
