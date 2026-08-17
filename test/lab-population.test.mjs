import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { runGenesis } from "../dist/lab/genesis.js";
import { populationSeed } from "../dist/lab/manifest.js";
import {
  createPopulationId,
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
  const directory = join(runsRoot, config.experimentId, "U0001", summary.runId);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const replay = await ReplayEngine.replayFile(
    join(directory, "events.jsonl"),
    manifest,
    config,
  );

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
  const populationId = createPopulationId(config, 4);
  assert.equal(
    await readFile(
      populationSummaryPath(serialRoot, config.experimentId, populationId),
      "utf8",
    ),
    canonicalJson(serial),
  );
});

test("distinct population inputs coexist and an identical rerun is idempotent", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const firstConfig = testConfig("population-catalog-first");
  const secondConfig = testConfig("population-catalog-second");

  const first = await runPopulation({
    config: firstConfig,
    runsRoot,
    universes: 2,
    parallel: 1,
  });
  const firstId = createPopulationId(firstConfig, 2);
  const firstPath = populationSummaryPath(runsRoot, firstConfig.experimentId, firstId);
  const firstBytes = await readFile(firstPath, "utf8");

  const second = await runPopulation({
    config: secondConfig,
    runsRoot,
    universes: 2,
    parallel: 2,
  });
  const secondId = createPopulationId(secondConfig, 2);
  const secondPath = populationSummaryPath(runsRoot, secondConfig.experimentId, secondId);

  assert.notEqual(firstId, secondId);
  assert.notEqual(firstId, createPopulationId(firstConfig, 1));
  assert.equal(firstId, createPopulationId(structuredClone(firstConfig), 2));
  assert.equal(firstBytes, canonicalJson(first));
  assert.equal(await readFile(secondPath, "utf8"), canonicalJson(second));
  assert.deepEqual(
    (await readdir(join(runsRoot, firstConfig.experimentId, "populations"))).sort(),
    [firstId, secondId].sort(),
  );

  const repeated = await runPopulation({
    config: firstConfig,
    runsRoot,
    universes: 2,
    parallel: 2,
  });
  assert.deepEqual(repeated, first);
  assert.equal(await readFile(firstPath, "utf8"), firstBytes);
  assert.equal(
    populationSummaryPath(runsRoot, firstConfig.experimentId),
    join(runsRoot, firstConfig.experimentId, "population.json"),
    "the two-argument helper remains a legacy-read path",
  );
});

test("an injected runner cannot publish a forged summary over valid universe evidence", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const config = testConfig("population-forged-summary");
  let authenticSummary;
  const forgedExecutor = async (options) => {
    authenticSummary = await runGenesis(options);
    return {
      ...authenticSummary,
      events: authenticSummary.events + 1,
      finalStateHash: "f".repeat(64),
    };
  };

  await assert.rejects(
    runPopulation({
      config,
      runsRoot,
      universes: 1,
      runUniverse: forgedExecutor,
    }),
    (error) => {
      assert.ok(error instanceof PopulationRunError);
      assert.equal(error.failures.length, 1);
      assert.match(error.failures[0].cause.message, /summary does not match verified evidence/);
      return true;
    },
  );
  assert.ok(authenticSummary);

  const populationId = createPopulationId(config, 1);
  const path = populationSummaryPath(runsRoot, config.experimentId, populationId);
  await assert.rejects(
    readFile(path, "utf8"),
    (error) => error.code === "ENOENT",
  );
  assert.deepEqual(
    JSON.parse(await readFile(
      join(
        runsRoot,
        config.experimentId,
        authenticSummary.universeId,
        authenticSummary.runId,
        "summary.json",
      ),
      "utf8",
    )),
    authenticSummary,
  );

  const verified = await runPopulation({
    config,
    runsRoot,
    universes: 1,
    runUniverse: runGenesis,
  });
  assert.deepEqual(verified.universes, [authenticSummary]);
  assert.equal(await readFile(path, "utf8"), canonicalJson(verified));
});

test("an injected runner cannot mutate its per-universe scientific identity", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const config = testConfig("population-immutable-input");

  await assert.rejects(
    runPopulation({
      config,
      runsRoot,
      universes: 1,
      runUniverse: async (options) => {
        options.config.seed = "executor-mutated-seed";
        return runGenesis(options);
      },
    }),
    (error) => {
      assert.ok(error instanceof PopulationRunError);
      assert.match(error.failures[0].cause.message, /wrong run id/);
      return true;
    },
  );
  const populationId = createPopulationId(config, 1);
  await assert.rejects(
    readFile(populationSummaryPath(runsRoot, config.experimentId, populationId), "utf8"),
    (error) => error.code === "ENOENT",
  );
});

test("population publication refuses a symbolic-link directory hierarchy", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const outside = await temporaryRoot(t);
  const config = testConfig("population-symlink");
  await mkdir(join(runsRoot, config.experimentId), { recursive: true });
  await symlink(outside, join(runsRoot, config.experimentId, "populations"), "dir");

  await assert.rejects(
    runPopulation({
      config,
      runsRoot,
      universes: 1,
    }),
    /Refusing symbolic link/,
  );
  const populationId = createPopulationId(config, 1);
  await assert.rejects(
    readFile(join(outside, populationId, "population.json"), "utf8"),
    (error) => error.code === "ENOENT",
  );
});

test("population publication refuses a symbolic-link destination", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const outside = await temporaryRoot(t);
  const config = testConfig("population-file-symlink");
  const populationId = createPopulationId(config, 1);
  const path = populationSummaryPath(runsRoot, config.experimentId, populationId);
  const outsideFile = join(outside, "protected.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(outsideFile, "protected", "utf8");
  await symlink(outsideFile, path, "file");

  await assert.rejects(
    runPopulation({
      config,
      runsRoot,
      universes: 1,
    }),
    /Refusing symbolic link file/,
  );
  assert.equal(await readFile(outsideFile, "utf8"), "protected");
});

test("a failed population preserves every completed universe evidence directory", async (t) => {
  const runsRoot = await temporaryRoot(t);
  const config = testConfig("population-failure-seed");
  const completed = [];

  const runUniverse = async (options) => {
    const summary = await runGenesis(options);
    completed.push(summary);
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
  assert.deepEqual(
    completed.map((summary) => summary.universeId).sort(),
    ["U0001", "U0002", "U0003"],
  );
  for (const completedSummary of completed) {
    const summary = JSON.parse(await readFile(
      join(
        runsRoot,
        config.experimentId,
        completedSummary.universeId,
        completedSummary.runId,
        "summary.json",
      ),
      "utf8",
    ));
    assert.equal(summary.universeId, completedSummary.universeId);
  }
  const populationId = createPopulationId(config, 3);
  await assert.rejects(
    readFile(populationSummaryPath(runsRoot, config.experimentId, populationId), "utf8"),
    (error) => error.code === "ENOENT",
  );
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
