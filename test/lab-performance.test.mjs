import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGenesisAgents } from "../dist/lab/agent-factory.js";
import { createCapabilityState } from "../dist/lab/capability-registry.js";
import { hashValue } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { LabEventRecorder } from "../dist/lab/event-recorder.js";
import { createLabEvent, initialEventHash } from "../dist/lab/events.js";
import { deterministicId } from "../dist/lab/ids.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import {
  applyWorldEventMutable,
  initialWorldState,
  prepareWorldEventTransition,
  reduceWorldEvent,
} from "../dist/lab/reducer.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { LogicalUniverse } from "../dist/lab/world.js";

function resources(value) {
  return {
    credits: value,
    llmTokens: value,
    computeMs: value,
    storageBytes: value,
    bandwidthBytes: value,
  };
}

function performanceConfig(seed, ticks = 6, agents = 4) {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = seed;
  config.ticks = ticks;
  config.agents = agents;
  config.metricEvery = 2;
  config.checkpointEvery = ticks;
  config.initialResources = resources(100_000);
  config.treasuryResources = resources(100_000);
  config.acceptedTaskReward = resources(0);
  config.taskStream = {
    families: ["arithmetic"],
    tasksPerTick: 1,
    deadlineTicks: ticks + 2,
    maxBacklog: 32,
  };
  config.pressures = [
    { tick: ticks + 10, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 1_000_000 },
    { tick: ticks + 11, type: "bandwidth_capacity_multiplier", multiplierPpm: 1_000_000 },
    { tick: ticks + 12, type: "retire_agent_fraction", fractionPpm: 0 },
    { tick: ticks + 13, type: "task_load_multiplier", multiplierPpm: 1_000_000 },
  ];
  return config;
}

test("mutable, pure, array, and file projections remain byte-equivalent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-projection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = performanceConfig("projection-equivalence");
  const manifest = createRunManifest(config, "U0001");
  const path = join(directory, "events.jsonl");
  const recorder = await LabEventRecorder.open(path, manifest);
  const live = await new LogicalUniverse(manifest, config, recorder).run();
  const events = recorder.events();

  let pure = initialWorldState(manifest);
  const mutable = initialWorldState(manifest);
  for (const event of events) {
    const eventBefore = structuredClone(event);
    pure = reduceWorldEvent(pure, event);
    assert.strictEqual(applyWorldEventMutable(mutable, event), mutable);
    assert.deepEqual(event, eventBefore, "projection must never mutate event evidence");
    assert.equal(hashValue(mutable), hashValue(pure));
  }

  const arrayReplay = ReplayEngine.replay(events, manifest, config);
  const fileReplay = await ReplayEngine.replayFile(path, manifest, config);
  assert.deepEqual(mutable, pure);
  assert.deepEqual(mutable, live);
  assert.equal(arrayReplay.stateHash, hashValue(live));
  assert.equal(fileReplay.stateHash, arrayReplay.stateHash);
  assert.equal(fileReplay.finalEventHash, recorder.lastHash);
});

test("prepared transitions preflight atomically, apply once, and reject stale worlds", () => {
  const config = performanceConfig("atomic-preflight", 2, 2);
  const manifest = createRunManifest(config, "U0001");
  const state = initialWorldState(manifest);
  const genesisHash = initialEventHash(manifest);
  const started = createLabEvent(manifest, {
    tick: 0,
    phase: "genesis",
    type: "run.started",
    data: { treasury: config.treasuryResources },
  }, 1, genesisHash);

  const initialDigest = hashValue(state);
  const startedTransition = prepareWorldEventTransition(state, started);
  assert.equal(hashValue(state), initialDigest, "preflight must not mutate the world");
  assert.throws(
    () => startedTransition.apply({ ...started, hash: "f".repeat(64) }),
    /does not match prepared transition/,
  );
  assert.strictEqual(startedTransition.apply(started), state);
  assert.throws(() => startedTransition.apply(started), /already been applied/);

  const [firstAgent, secondAgent] = createGenesisAgents(config);
  const firstCreated = createLabEvent(manifest, {
    tick: 0,
    phase: "genesis",
    type: "agent.created",
    actorId: firstAgent.id,
    data: { agent: firstAgent },
  }, 2, started.hash);
  const alternativeCreated = createLabEvent(manifest, {
    tick: 0,
    phase: "genesis",
    type: "agent.created",
    actorId: firstAgent.id,
    data: { agent: firstAgent },
  }, 2, started.hash);
  const stale = prepareWorldEventTransition(state, alternativeCreated);
  applyWorldEventMutable(state, firstCreated);
  assert.throws(() => stale.apply(alternativeCreated), /World changed/);

  const secondCreated = createLabEvent(manifest, {
    tick: 0,
    phase: "genesis",
    type: "agent.created",
    actorId: secondAgent.id,
    data: { agent: secondAgent },
  }, 3, firstCreated.hash);
  applyWorldEventMutable(state, secondCreated);

  const invalidSpend = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "resource.spent",
    actorId: secondAgent.id,
    data: {
      agentId: secondAgent.id,
      action: "observe",
      cost: { ...resources(0), credits: config.initialResources.credits + 1 },
    },
  }, 4, secondCreated.hash);
  const beforeInvalidSpend = hashValue(state);
  assert.throws(
    () => prepareWorldEventTransition(state, invalidSpend),
    /insufficient credits/,
  );
  assert.equal(hashValue(state), beforeInvalidSpend, "failed resource preflight must be atomic");

  const cost = {
    credits: 7,
    llmTokens: 0,
    computeMs: 3,
    storageBytes: 0,
    bandwidthBytes: 0,
  };
  const capability = createCapabilityState(firstAgent.id, 1, {
    id: "cap://math/sum/v1",
    inputs: ["a", "b"],
    outputs: ["total"],
    primitivePlan: ["execute"],
    executionPlan: [{ op: "sum", inputs: ["a", "b"], output: "total" }],
    tests: [{ input: { a: 2, b: 3 }, output: { total: 5 } }],
    cost,
  });
  const published = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "capability.published",
    actorId: firstAgent.id,
    causationId: secondCreated.eventId,
    data: { capability },
  }, 4, secondCreated.hash);
  applyWorldEventMutable(state, published);

  const invocationId = deterministicId(
    "capability-invocation",
    manifest.runId,
    manifest.universeId,
    1,
    secondAgent.id,
    capability.id,
    0,
  );
  const unjustifiedRejection = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "capability.used",
    actorId: secondAgent.id,
    targetId: firstAgent.id,
    causationId: secondCreated.eventId,
    data: {
      invocation: {
        id: invocationId,
        capabilityId: capability.id,
        callerId: secondAgent.id,
        input: { a: 2, b: 3 },
        accepted: false,
        success: false,
        chargedCost: resources(0),
        createdTick: 1,
        localIndex: 0,
        reason: "execution_failed",
      },
    },
  }, 5, published.hash);
  assert.throws(
    () => prepareWorldEventTransition(state, unjustifiedRejection),
    /cannot be rejected when execution and payment are valid/,
  );

  const openReasonRejection = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "capability.used",
    actorId: secondAgent.id,
    targetId: firstAgent.id,
    causationId: secondCreated.eventId,
    data: {
      invocation: {
        id: invocationId,
        capabilityId: capability.id,
        callerId: secondAgent.id,
        input: { a: 2, b: "invalid" },
        accepted: false,
        success: false,
        chargedCost: resources(0),
        createdTick: 1,
        localIndex: 0,
        reason: "sum input was invalid",
      },
    },
  }, 5, published.hash);
  assert.throws(
    () => prepareWorldEventTransition(state, openReasonRejection),
    /reason code execution_failed/,
  );

  const invocation = {
    id: invocationId,
    capabilityId: capability.id,
    callerId: secondAgent.id,
    input: { a: 2, b: 3 },
    accepted: true,
    success: true,
    output: { total: 999 },
    chargedCost: cost,
    paymentTo: firstAgent.id,
    createdTick: 1,
    localIndex: 0,
  };
  const forged = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "capability.used",
    actorId: secondAgent.id,
    targetId: firstAgent.id,
    causationId: secondCreated.eventId,
    data: { invocation },
  }, 5, published.hash);
  const beforeForgedInvocation = hashValue(state);
  assert.throws(
    () => prepareWorldEventTransition(state, forged),
    /output does not match its deterministic plan/,
  );
  assert.equal(hashValue(state), beforeForgedInvocation, "forged output must not charge resources");

  invocation.output = { total: 5 };
  const valid = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "capability.used",
    actorId: secondAgent.id,
    targetId: firstAgent.id,
    causationId: secondCreated.eventId,
    data: { invocation },
  }, 5, published.hash);
  const callerCredits = state.agents[secondAgent.id].resources.credits;
  const ownerCredits = state.agents[firstAgent.id].resources.credits;
  applyWorldEventMutable(state, valid);
  assert.equal(state.agents[secondAgent.id].resources.credits, callerCredits - cost.credits);
  assert.equal(state.agents[firstAgent.id].resources.credits, ownerCredits + cost.credits);
  assert.equal(state.capabilities[capability.id].usageCount, 1);
  assert.equal(state.capabilities[capability.id].successCount, 1);
});

test("causal preflight rejects impossible links, sends, evaluations, and counter overflow", () => {
  const config = performanceConfig("semantic-preflight", 3, 2);
  const manifest = createRunManifest(config, "U0001");
  const state = initialWorldState(manifest);
  const [firstAgent, secondAgent] = createGenesisAgents(config);
  state.agents[firstAgent.id] = firstAgent;
  state.agents[secondAgent.id] = secondAgent;
  const previousHash = initialEventHash(manifest);

  const repeatedStart = createLabEvent(manifest, {
    tick: 0,
    phase: "genesis",
    type: "run.started",
    data: { treasury: config.treasuryResources },
  }, 2, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, repeatedStart), /first genesis event/);

  const eventBeforeStart = createLabEvent(manifest, {
    tick: 0,
    phase: "task_generation",
    type: "task.created",
    data: {
      task: {
        id: "task:before-start",
        family: "arithmetic",
        input: { left: 1, right: 1, operation: "add" },
        createdTick: 0,
        deadlineTick: 2,
        status: "available",
      },
    },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, eventBeforeStart), /cannot precede run.started/);
  state.started = true;

  const mismatchedAgent = createLabEvent(manifest, {
    tick: 0,
    phase: "genesis",
    type: "agent.created",
    actorId: secondAgent.id,
    data: { agent: firstAgent },
  }, 2, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, mismatchedAgent), /actorId must match/);
  const orphanAgent = createLabEvent(manifest, {
    tick: 0,
    phase: "genesis",
    type: "agent.created",
    actorId: firstAgent.id,
    data: { agent: firstAgent },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, orphanAgent), /must follow the seq-1 run.started/);

  const forgedLink = createLabEvent(manifest, {
    tick: 0,
    phase: "resolution",
    type: "link.created",
    actorId: firstAgent.id,
    targetId: secondAgent.id,
    causationId: "payment:event",
    data: {
      link: {
        id: "link:forged",
        left: firstAgent.id,
        right: secondAgent.id,
        strengthPpm: 1_000_000,
        createdTick: 0,
        lastUsedTick: 0,
      },
    },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, forgedLink), /Link id is not deterministic/);

  const message = {
    id: deterministicId(
      "message",
      manifest.runId,
      manifest.universeId,
      1,
      firstAgent.id,
      secondAgent.id,
      0,
    ),
    senderId: firstAgent.id,
    recipientId: secondAgent.id,
    payload: { text: "impossible without a link" },
    sentTick: 1,
    linkId: "link:missing",
    localIndex: 0,
  };
  const impossibleSend = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "message.sent",
    actorId: firstAgent.id,
    targetId: secondAgent.id,
    data: { message },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, impossibleSend), /active link/);
  const mismatchedSend = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "message.sent",
    actorId: secondAgent.id,
    targetId: firstAgent.id,
    data: { message },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, mismatchedSend), /participants do not match/);

  const unknownResource = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "resource.spent",
    actorId: firstAgent.id,
    data: {
      agentId: firstAgent.id,
      action: "observe",
      cost: { ...resources(0), gold: 1 },
    },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, unknownResource), /unknown resource gold/);

  firstAgent.actionCounts.observe = Number.MAX_SAFE_INTEGER;
  const overflowingAction = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "resource.spent",
    actorId: firstAgent.id,
    data: { agentId: firstAgent.id, action: "observe", cost: resources(0) },
  }, 1, previousHash);
  const beforeOverflow = hashValue(state);
  assert.throws(() => prepareWorldEventTransition(state, overflowingAction), /safe-integer range/);
  assert.equal(hashValue(state), beforeOverflow);
  firstAgent.actionCounts.observe = 0;

  firstAgent.violations = Number.MAX_SAFE_INTEGER;
  const overflowingViolation = createLabEvent(manifest, {
    tick: 1,
    phase: "resolution",
    type: "violation.recorded",
    actorId: firstAgent.id,
    data: { agentId: firstAgent.id, action: "reason", reason: "test", count: 1 },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, overflowingViolation), /safe-integer range/);
  firstAgent.violations = 0;

  state.tasks["task:1"] = {
    id: "task:1",
    family: "arithmetic",
    input: { left: 1, right: 2, operation: "add" },
    createdTick: 1,
    deadlineTick: 10,
    status: "submitted",
    claimedBy: firstAgent.id,
    submittedBy: firstAgent.id,
  };
  state.submissions["submission:1"] = {
    id: "submission:1",
    taskId: "task:1",
    agentId: firstAgent.id,
    result: 3,
    submittedTick: 2,
    submittedSeq: 1,
    submittedEventId: "event:submitted",
    accepted: false,
    qualityPpm: 0,
    latencyTicks: 0,
  };
  state.submissionOrder.push("submission:1");

  const mismatchedVerification = createLabEvent(manifest, {
    tick: 3,
    phase: "resolution",
    type: "submission.verified",
    actorId: secondAgent.id,
    targetId: secondAgent.id,
    data: {
      verification: {
        id: deterministicId("verification", manifest.runId, "submission:1", secondAgent.id),
        submissionId: "submission:1",
        verifierId: secondAgent.id,
        computedResult: 3,
        verdict: true,
        matchesSubmission: true,
        createdTick: 3,
      },
    },
  }, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, mismatchedVerification), /participants do not match/);

  const evaluationDraft = {
    tick: 3,
    phase: "evaluation",
    type: "task.evaluated",
    actorId: firstAgent.id,
    causationId: "event:submitted",
    data: {
      taskId: "task:1",
      submissionId: "submission:1",
      accepted: true,
      qualityPpm: 1_000_000,
      latencyTicks: 1,
      completedTick: 3,
      violations: 0,
    },
  };
  const wrongLatency = createLabEvent(manifest, evaluationDraft, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, wrongLatency), /does not match task age 2/);

  firstAgent.taskCounts.arithmetic = Number.MAX_SAFE_INTEGER;
  const validEvaluationDraft = structuredClone(evaluationDraft);
  validEvaluationDraft.data.latencyTicks = 2;
  const overflowingEvaluation = createLabEvent(manifest, validEvaluationDraft, 1, previousHash);
  assert.throws(() => prepareWorldEventTransition(state, overflowingEvaluation), /safe-integer range/);
  firstAgent.taskCounts.arithmetic = 0;

  applyWorldEventMutable(state, overflowingEvaluation);
  assert.equal(state.tasks["task:1"].status, "completed");
  const duplicateEvaluation = createLabEvent(manifest, validEvaluationDraft, 2, overflowingEvaluation.hash);
  assert.throws(() => prepareWorldEventTransition(state, duplicateEvaluation), /not submitted/);
});

test("appendPrepared rejects stale chain previews before writing bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-prepared-recorder-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = performanceConfig("prepared-recorder", 1, 1);
  const manifest = createRunManifest(config, "U0001");
  const path = join(directory, "events.jsonl");
  const recorder = await LabEventRecorder.open(path, manifest);
  const first = createLabEvent(manifest, {
    tick: 1,
    phase: "upkeep",
    type: "tick.completed",
    data: { tick: 1 },
  }, 1, initialEventHash(manifest));
  await recorder.appendPrepared(first);
  const committedBytes = await readFile(path, "utf8");

  await assert.rejects(recorder.appendPrepared(first), /Expected event sequence 2/);
  assert.equal(await readFile(path, "utf8"), committedBytes);

  const backwards = createLabEvent(manifest, {
    tick: 0,
    phase: "upkeep",
    type: "tick.completed",
    data: { tick: 0 },
  }, 2, recorder.lastHash);
  await assert.rejects(recorder.appendPrepared(backwards), /moves logical time backwards/);
  assert.equal(await readFile(path, "utf8"), committedBytes);

  const oversized = createLabEvent(manifest, {
    tick: 2,
    phase: "upkeep",
    type: "tick.completed",
    data: { payload: "x".repeat(262_144) },
  }, 2, recorder.lastHash);
  await assert.rejects(recorder.appendPrepared(oversized), /262144-byte limit/);
  await assert.rejects(recorder.append({
    tick: 2,
    phase: "upkeep",
    type: "tick.completed",
    data: { payload: "x".repeat(262_144) },
  }), /262144-byte limit/);
  assert.equal(await readFile(path, "utf8"), committedBytes);
  assert.equal(recorder.lastSeq, 1);
  assert.equal(recorder.lastTick, 1);
  assert.equal(recorder.lastHash, first.hash);

  const reopened = await LabEventRecorder.open(path, manifest);
  assert.equal(reopened.lastSeq, 1);
  assert.equal(reopened.lastTick, 1);
  assert.equal(reopened.lastHash, first.hash);
});

test("a complete world run performs no internal full-state structured clones", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anu-lab-no-world-clone-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = performanceConfig("no-world-clone", 4, 4);
  const manifest = createRunManifest(config, "U0001");
  const recorder = await LabEventRecorder.open(join(directory, "events.jsonl"), manifest);
  const universe = new LogicalUniverse(manifest, config, recorder);
  const nativeStructuredClone = globalThis.structuredClone;
  let worldCloneCount = 0;

  globalThis.structuredClone = (value, options) => {
    if (
      value
      && typeof value === "object"
      && value.schemaVersion === 1
      && Object.hasOwn(value, "agents")
      && Object.hasOwn(value, "physics")
      && Object.hasOwn(value, "resourceSpent")
      && Object.hasOwn(value, "completed")
    ) {
      worldCloneCount += 1;
    }
    return nativeStructuredClone(value, options);
  };

  try {
    const state = await universe.run();
    assert.equal(state.completed, true);
  } finally {
    globalThis.structuredClone = nativeStructuredClone;
  }
  assert.equal(worldCloneCount, 1, "only the public run() return value may clone the full world");
});
