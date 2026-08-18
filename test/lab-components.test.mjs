import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { IndependentEvaluator } from "../dist/lab/evaluator.js";
import { computeMetrics, giniPpm, specializationPpm } from "../dist/lab/metrics.js";
import { NeutralPolicy, solveTask } from "../dist/lab/neutral-policy.js";
import { PressureEngine } from "../dist/lab/pressure-engine.js";
import { ResourcePhysics } from "../dist/lab/resource-physics.js";
import { DeterministicRng } from "../dist/lab/rng.js";
import { DeterministicTaskStream } from "../dist/lab/task-stream.js";
import { LAB_SCHEMA_VERSION, PPM } from "../dist/lab/types.js";

const resources = (value = 0) => ({
  credits: value,
  llmTokens: value,
  computeMs: value,
  storageBytes: value,
  bandwidthBytes: value,
});

const physics = () => ({
  resourcePricePpm: {
    credits: PPM,
    llmTokens: PPM,
    computeMs: PPM,
    storageBytes: PPM,
    bandwidthBytes: PPM,
  },
  bandwidthCapacityPpm: PPM,
  taskLoadPpm: PPM,
});

function agent(id, overrides = {}) {
  return {
    id,
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
    ...overrides,
  };
}

function world(overrides = {}) {
  return {
    schemaVersion: LAB_SCHEMA_VERSION,
    runId: "run:test",
    universeId: "U-test",
    configHash: "hash",
    seed: "seed",
    tick: 0,
    agents: {},
    links: {},
    tasks: {},
    submissions: {},
    capabilities: {},
    physics: physics(),
    treasury: resources(0),
    resourceSpent: resources(0),
    metrics: [],
    completed: false,
    ...overrides,
  };
}

test("resource physics uses safe integers and conserves every spend and transfer", () => {
  const engine = new ResourcePhysics();
  const stressed = physics();
  stressed.resourcePricePpm.credits = 2 * PPM;
  stressed.bandwidthCapacityPpm = PPM / 2;
  const scaled = engine.scaledCost({ ...resources(0), credits: 3, bandwidthBytes: 100 }, stressed);
  assert.equal(scaled.credits, 6);
  assert.equal(scaled.bandwidthBytes, 200);

  const source = { ...resources(1_000), credits: 10 };
  const collector = resources(0);
  const movement = engine.spend(source, collector, scaled);
  assert.equal(movement.source.credits, 4);
  assert.equal(movement.target.credits, 6);
  assert.equal(movement.source.bandwidthBytes, 800);
  assert.equal(movement.target.bandwidthBytes, 200);
  assert.equal(source.credits, 10, "operations are atomic and do not mutate their inputs");
  engine.assertConserved([source, collector], [movement.source, movement.target]);

  const transferred = engine.transfer(movement.source, movement.target, "computeMs", 17);
  engine.assertConserved([movement.source, movement.target], [transferred.source, transferred.target]);
  assert.throws(() => engine.transfer(resources(0), resources(0), "credits", 1), /insufficient/);
  assert.throws(() => engine.scaledCost({ ...resources(0), credits: -1 }, physics()), /non-negative/);
  assert.throws(() => engine.assertConserved(resources(1), resources(2)), /not conserved/);
});

test("independent evaluator keeps an immutable hidden oracle", () => {
  const evaluator = new IndependentEvaluator();
  const expected = { alpha: [1, 2], beta: true };
  const task = {
    id: "task:1",
    family: "json_transform",
    input: { operation: "opaque-public-input" },
    createdTick: 4,
    deadlineTick: 20,
    status: "submitted",
  };
  evaluator.registerOracle(task.id, expected);
  expected.alpha.push(3);
  const accepted = evaluator.evaluate(task, "submission:1", "N0001", { beta: true, alpha: [1, 2] }, 7);
  assert.deepEqual(accepted, {
    taskId: task.id,
    submissionId: "submission:1",
    accepted: true,
    qualityPpm: PPM,
    latencyTicks: 3,
    violations: 0,
  });
  assert.equal(evaluator.evaluate(task, "submission:2", "N0001", null, 8).qualityPpm, 0);
  assert.throws(() => evaluator.registerOracle(task.id, null), /already registered/);
});

test("task stream and deterministic cognition reproduce all task families", () => {
  const first = new DeterministicTaskStream(DEFAULT_GENESIS_CONFIG.taskStream, new DeterministicRng("stream-seed"));
  const second = new DeterministicTaskStream(DEFAULT_GENESIS_CONFIG.taskStream, new DeterministicRng("stream-seed"));
  assert.deepEqual(first.generate(3, 20), second.generate(3, 20));

  for (const family of DEFAULT_GENESIS_CONFIG.taskStream.families) {
    const stream = new DeterministicTaskStream({
      families: [family],
      tasksPerTick: 1,
      deadlineTicks: 10,
      maxBacklog: 10,
    }, new DeterministicRng(`family/${family}`));
    const [{ task, expected }] = stream.generate(2, 1);
    assert.equal(Object.hasOwn(task, "expected"), false);
    const result = solveTask(task);
    const evaluator = new IndependentEvaluator();
    evaluator.registerOracle(task.id, expected);
    assert.equal(evaluator.evaluate(task, `submission:${family}`, "N0001", result, 3).accepted, true, family);
  }
});

test("pressure engine exposes exactly four deterministic logical pressures", () => {
  const agents = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const value = agent(`N${String(index).padStart(2, "0")}`);
    return [value.id, value];
  }));
  const state = world({ agents });
  const engine = new PressureEngine(DEFAULT_GENESIS_CONFIG.pressures);
  const rng = new DeterministicRng("pressure-seed");
  const applied = DEFAULT_GENESIS_CONFIG.pressures.map((pressure) => engine.forTick(pressure.tick, state, rng));
  assert.equal(applied.flatMap((result) => result.events).length, 4);
  assert.equal(applied[2].retiredAgentIds.length, 2);
  assert.equal(new Set(applied[2].retiredAgentIds).size, 2);
  assert.equal(engine.forTick(DEFAULT_GENESIS_CONFIG.pressures[0].tick, state, rng).events.length, 0);
  assert.throws(() => new PressureEngine(DEFAULT_GENESIS_CONFIG.pressures.slice(0, 3)), /exactly 4/);

  const replay = new PressureEngine(DEFAULT_GENESIS_CONFIG.pressures);
  const replayResults = DEFAULT_GENESIS_CONFIG.pressures.map((pressure) => (
    replay.forTick(pressure.tick, state, new DeterministicRng("pressure-seed").fork(pressure.tick))
  ));
  const replayAgain = new PressureEngine(DEFAULT_GENESIS_CONFIG.pressures);
  const secondResults = DEFAULT_GENESIS_CONFIG.pressures.map((pressure) => (
    replayAgain.forTick(pressure.tick, state, new DeterministicRng("pressure-seed").fork(pressure.tick))
  ));
  assert.deepEqual(replayResults, secondResults);
});

test("metrics use exact fixed-point graph, inequality and specialization formulas", () => {
  const uniformCounts = Object.fromEntries(DEFAULT_GENESIS_CONFIG.taskStream.families.map((family) => [family, 1]));
  const agents = {
    A: agent("A", { resources: { ...resources(100), credits: 90, computeMs: 80, bandwidthBytes: 70 }, taskCounts: { arithmetic: 10 } }),
    B: agent("B", { resources: { ...resources(100), credits: 90, computeMs: 80, bandwidthBytes: 70 }, taskCounts: uniformCounts }),
    C: agent("C", { resources: { ...resources(100), credits: 90, computeMs: 80, bandwidthBytes: 70 } }),
    D: agent("D", { resources: { ...resources(100), credits: 90, computeMs: 80, bandwidthBytes: 70 }, taskCounts: { verification: 10 } }),
  };
  const tasks = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`T${index}`, {
    id: `T${index}`,
    family: "arithmetic",
    input: index,
    createdTick: 0,
    deadlineTick: 20,
    status: index < 3 ? "completed" : "available",
  }]));
  const submissions = {
    S1: { id: "S1", taskId: "T0", agentId: "A", result: 1, submittedTick: 2, accepted: true, qualityPpm: PPM, latencyTicks: 2 },
    S2: { id: "S2", taskId: "T1", agentId: "D", result: 1, submittedTick: 10, accepted: true, qualityPpm: PPM, latencyTicks: 10 },
    S3: { id: "S3", taskId: "T2", agentId: "C", result: 0, submittedTick: 5, accepted: false, qualityPpm: 0, latencyTicks: 5 },
  };
  const state = world({
    tick: 10,
    agents,
    links: {
      AB: { id: "AB", left: "A", right: "B", strengthPpm: PPM, createdTick: 0, lastUsedTick: 10 },
      AC: { id: "AC", left: "A", right: "C", strengthPpm: PPM, createdTick: 0, lastUsedTick: 10 },
      AD: { id: "AD", left: "A", right: "D", strengthPpm: PPM, createdTick: 0, lastUsedTick: 10 },
    },
    tasks,
    submissions,
    resourceSpent: { ...resources(0), credits: 40, computeMs: 80, bandwidthBytes: 120 },
  });
  const metrics = computeMetrics(state, resources(400));
  assert.equal(metrics.tasksCompleted, 3);
  assert.equal(metrics.taskSuccessRatePpm, 500_000);
  assert.equal(metrics.meanQualityPpm, 666_666);
  assert.equal(metrics.p50LatencyTicks, 2);
  assert.equal(metrics.p95LatencyTicks, 10);
  assert.equal(metrics.creditsPerAcceptedTaskPpm, 20 * PPM);
  assert.equal(metrics.computePerAcceptedTaskPpm, 40 * PPM);
  assert.equal(metrics.bandwidthPerAcceptedTaskPpm, 60 * PPM);
  assert.equal(metrics.densityPpm, 500_000);
  assert.equal(metrics.connectedComponents, 1);
  assert.equal(metrics.degreeCentralizationPpm, PPM);
  assert.equal(metrics.resourceGiniPpm, 0);
  assert.equal(metrics.meanSpecializationPpm, 500_000);
  assert.equal(metrics.linkTurnover, 3);
  assert.equal(giniPpm([0, 0, 0, 100]), 750_000);
  assert.equal(specializationPpm(agents.B), 0);
});

test("neutral policy has identical logic and call-order-independent per-agent streams", () => {
  const stateA = agent("A");
  const stateB = agent("B");
  const observationA = {
    tick: 0,
    agentId: "A",
    resources: resources(100),
    tasks: [],
    visibleAgents: ["B"],
    neighbors: [],
    capabilities: [],
    physics: physics(),
  };
  const observationB = { ...observationA, agentId: "B", visibleAgents: ["A"] };

  const firstPolicy = new NeutralPolicy();
  const firstRoot = new DeterministicRng("policy-seed");
  const firstA = firstPolicy.decide(observationA, stateA, firstRoot);
  const firstB = firstPolicy.decide(observationB, stateB, firstRoot);

  const secondPolicy = new NeutralPolicy();
  const secondRoot = new DeterministicRng("policy-seed");
  const secondB = secondPolicy.decide(observationB, stateB, secondRoot);
  const secondA = secondPolicy.decide(observationA, stateA, secondRoot);
  assert.deepEqual(firstA, secondA);
  assert.deepEqual(firstB, secondB);
  assert.doesNotMatch(JSON.stringify([firstA, firstB]), /developer|manager|architect|qa|router|backend/i);
});
