import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { createGenesisAgents } from "../dist/lab/agent-factory.js";
import { assertNoOracleLeak, observeWorld } from "../dist/lab/environment.js";
import { LabEventRecorder } from "../dist/lab/event-recorder.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import { ReplayEngine } from "../dist/lab/replay.js";
import { initialWorldState } from "../dist/lab/reducer.js";
import { RESOURCE_KINDS } from "../dist/lab/resource-physics.js";
import { solveTask } from "../dist/lab/neutral-policy.js";
import { LogicalUniverse } from "../dist/lab/world.js";

function configFor(seed, ticks, agents, tasksPerTick = 0) {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = seed;
  config.ticks = ticks;
  config.agents = agents;
  config.metricEvery = ticks;
  config.checkpointEvery = ticks;
  config.initialResources = resources(10_000);
  config.treasuryResources = resources(10_000);
  config.acceptedTaskReward = resources(0);
  config.taskStream = {
    families: ["arithmetic"],
    tasksPerTick,
    deadlineTicks: ticks + 2,
    maxBacklog: 16,
  };
  config.pressures = [
    { tick: ticks + 10, type: "resource_price_multiplier", resource: "credits", multiplierPpm: 1_000_000 },
    { tick: ticks + 11, type: "bandwidth_capacity_multiplier", multiplierPpm: 1_000_000 },
    { tick: ticks + 12, type: "retire_agent_fraction", fractionPpm: 0 },
    { tick: ticks + 13, type: "task_load_multiplier", multiplierPpm: 1_000_000 },
  ];
  return config;
}

function resources(value) {
  return {
    credits: value,
    llmTokens: value,
    computeMs: value,
    storageBytes: value,
    bandwidthBytes: value,
  };
}

async function runWithPolicy(t, config, policy) {
  const directory = await mkdtemp(join(tmpdir(), "anu-causality-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = createRunManifest(config, "U0001", { policyId: policy.id });
  const recorder = await LabEventRecorder.open(join(directory, "events.jsonl"), manifest);
  const universe = new LogicalUniverse(manifest, config, recorder, { policy });
  const state = await universe.run();
  return { config, manifest, recorder, universe, state };
}

test("send creates and explicitly delivers deterministic messages through a bounded redacted inbox", async (t) => {
  const config = configFor("causal-message", 68, 2);
  config.initialResources = resources(1_000_000);
  const policy = {
    id: "test-scripted-message-v1",
    decide(observation) {
      if (observation.agentId === "N0001" && observation.tick === 1) {
        return [{ type: "connect", targetId: "N0002" }];
      }
      if (observation.agentId === "N0001" && observation.tick >= 2) {
        return [{
          type: "send",
          targetId: "N0002",
          payload: {
            public: "hello",
            sequence: observation.tick,
            expected: "must-not-cross-observation-boundary",
            nested: { visible: true, solution: 42 },
          },
        }];
      }
      return [];
    },
  };
  const result = await runWithPolicy(t, config, policy);
  const sent = result.recorder.events().find((event) => event.type === "message.sent");
  const delivered = result.recorder.events().find((event) => event.type === "message.delivered");
  assert.ok(sent);
  assert.ok(delivered);
  assert.equal(delivered.causationId, sent.eventId);
  assert.equal(Object.keys(result.state.messages).length, 67);

  const message = Object.values(result.state.messages)[0];
  assert.match(message.id, /^message:/);
  assert.equal(message.deliveredTick, 2);
  assert.equal(result.state.agents.N0002.inbox.length, 67);
  const recipientObservation = result.universe.lastObservations().find((item) => item.agentId === "N0002");
  assert.ok(recipientObservation);
  assert.doesNotThrow(() => assertNoOracleLeak(recipientObservation));
  assert.equal(recipientObservation.inbox.length, 64);
  assert.equal(recipientObservation.inbox[0].sentTick, 4);
  assert.equal(recipientObservation.inbox.at(-1).sentTick, 67);
  assert.equal(recipientObservation.inbox[0].payload.public, "hello");
  assert.equal(Object.hasOwn(recipientObservation.inbox[0].payload, "expected"), false);
  assert.equal(Object.hasOwn(recipientObservation.inbox[0].payload.nested, "solution"), false);
  assert.deepEqual(recipientObservation.inbox[0].redactedPaths, ["/expected", "/nested/solution"]);

  assert.throws(
    () => ReplayEngine.replay(result.recorder.events(), result.manifest, result.config),
    /Unsupported lab policyId/,
    "custom policies are identity-bound but fail closed until an authoritative verifier is registered",
  );
});

test("public submission window is deterministic and bounded to the latest 64 records", () => {
  const config = configFor("submission-window", 1, 2);
  const manifest = createRunManifest(config, "U0001");
  const state = initialWorldState(manifest);
  for (const agent of createGenesisAgents(config)) state.agents[agent.id] = agent;
  for (let index = 0; index < 65; index += 1) {
    const taskId = `task:${String(index).padStart(3, "0")}`;
    const submissionId = `submission:${String(index).padStart(3, "0")}`;
    state.tasks[taskId] = {
      id: taskId,
      family: "arithmetic",
      input: { left: index, right: 1, operation: "add" },
      createdTick: index,
      deadlineTick: index + 10,
      status: "submitted",
      claimedBy: "N0001",
      submittedBy: "N0001",
    };
    state.submissions[submissionId] = {
      id: submissionId,
      taskId,
      agentId: "N0001",
      result: index + 1,
      submittedTick: index,
      accepted: false,
      qualityPpm: 0,
      latencyTicks: 0,
    };
    state.submissionOrder.push(submissionId);
  }
  const observation = observeWorld(state, "N0002", 65);
  assert.equal(observation.submissions.length, 64);
  assert.equal(observation.submissions[0].id, "submission:001");
  assert.equal(observation.submissions.at(-1).id, "submission:064");
  assert.doesNotThrow(() => assertNoOracleLeak(observation));
});

test("verification records independent attestations and rejects self, duplicate, and inconsistent verdicts", async (t) => {
  const config = configFor("causal-verification", 5, 3, 1);
  let publicSubmissionId;
  let publicComputedResult;
  const policy = {
    id: "test-scripted-verification-v1",
    decide(observation, agent) {
      if (observation.agentId === "N0001") {
        const owned = observation.tasks.find((task) => task.claimedBy === agent.id);
        if (observation.tick === 1) {
          const available = observation.tasks.find((task) => task.status === "available");
          return available ? [{ type: "claimTask", taskId: available.id }] : [];
        }
        if (observation.tick === 2 && owned) {
          return [{ type: "execute", taskId: owned.id, result: solveTask(owned) }];
        }
        if (observation.tick === 3 && owned) {
          return [{ type: "submit", taskId: owned.id, result: solveTask(owned) }];
        }
      }
      const submission = observation.submissions[0];
      if (submission) {
        publicSubmissionId = submission.id;
        publicComputedResult = solveTask(submission.task);
      }
      if (observation.tick === 4 && observation.agentId === "N0002") {
        return [{ type: "verify", submissionId: publicSubmissionId, computedResult: publicComputedResult, verdict: true }];
      }
      if (observation.tick === 4 && observation.agentId === "N0003") {
        return [{ type: "verify", submissionId: publicSubmissionId, computedResult: publicComputedResult, verdict: false }];
      }
      if (observation.tick === 5 && observation.agentId === "N0001") {
        return [{ type: "verify", submissionId: publicSubmissionId, computedResult: publicComputedResult, verdict: true }];
      }
      if (observation.tick === 5 && observation.agentId === "N0002") {
        assert.equal(observation.submissions.length, 0, "verified submissions leave the bounded public queue");
        return [{ type: "verify", submissionId: publicSubmissionId, computedResult: publicComputedResult, verdict: true }];
      }
      return [];
    },
  };
  const result = await runWithPolicy(t, config, policy);
  const verifications = Object.values(result.state.verifications);
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].verifierId, "N0002");
  assert.equal(verifications[0].verdict, true);
  assert.equal(verifications[0].matchesSubmission, true);

  const submission = Object.values(result.state.submissions)[0];
  assert.equal(submission.accepted, true, "independent attestation must not rewrite evaluator acceptance");
  const verificationEvents = result.recorder.events().filter((event) => event.type === "submission.verified");
  assert.equal(verificationEvents.length, 1);
  const reasons = result.recorder.events()
    .filter((event) => event.type === "violation.recorded" && event.data.action === "verify")
    .map((event) => event.data.reason);
  assert.ok(reasons.some((reason) => String(reason).includes("own submissions")));
  assert.ok(reasons.some((reason) => String(reason).includes("already verified")));
  assert.ok(reasons.some((reason) => String(reason).includes("verdict")));
});

test("capability execution is bounded, records failures, and charges declared cost exactly once", async (t) => {
  const config = configFor("causal-capability", 3, 2);
  const declaredCost = {
    credits: 7,
    llmTokens: 0,
    computeMs: 3,
    storageBytes: 0,
    bandwidthBytes: 0,
  };
  const capability = {
    id: "cap://math/sum/v1",
    inputs: ["a", "b"],
    outputs: ["total"],
    primitivePlan: ["execute"],
    executionPlan: [{ op: "sum", inputs: ["a", "b"], output: "total" }],
    tests: [{ input: { a: 2, b: 3 }, output: { total: 5 } }],
    cost: declaredCost,
  };
  const policy = {
    id: "test-scripted-capability-v1",
    decide(observation) {
      if (observation.tick === 1 && observation.agentId === "N0001") {
        return [{ type: "publishCapability", capability }];
      }
      if (observation.tick === 2 && observation.agentId === "N0002") {
        return [{ type: "useCapability", capabilityId: capability.id, input: { a: 10, b: 4 } }];
      }
      if (observation.tick === 3 && observation.agentId === "N0002") {
        return [{ type: "useCapability", capabilityId: capability.id, input: { a: 10, b: "invalid" } }];
      }
      return [];
    },
  };
  const result = await runWithPolicy(t, config, policy);
  const published = result.state.capabilities[capability.id];
  assert.equal(published.usageCount, 1);
  assert.equal(published.successCount, 1);
  const invocations = Object.values(result.state.capabilityInvocations)
    .sort((left, right) => left.createdTick - right.createdTick);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].output, { total: 14 });
  assert.equal(invocations[0].accepted, true);
  assert.equal(invocations[0].success, true);
  assert.deepEqual(invocations[0].chargedCost, declaredCost);
  assert.equal(invocations[0].paymentTo, "N0001");
  assert.equal(invocations[1].accepted, false);
  assert.equal(invocations[1].success, false);
  assert.deepEqual(invocations[1].chargedCost, resources(0));
  assert.equal(invocations[1].reason, "execution_failed");

  assert.equal(result.state.agents.N0001.resources.credits, 10_000 - config.costs.publishCapability.credits + declaredCost.credits);
  assert.equal(result.state.agents.N0002.resources.credits, 10_000 - (2 * config.costs.useCapability.credits) - declaredCost.credits);
  assert.equal(result.state.treasury.credits, 10_000 + config.costs.publishCapability.credits + (2 * config.costs.useCapability.credits));
  const expectedTotals = Object.fromEntries(RESOURCE_KINDS.map((kind) => [
    kind,
    BigInt(config.treasuryResources[kind]) + BigInt(config.initialResources[kind]) * BigInt(config.agents),
  ]));
  const actualTotals = Object.fromEntries(RESOURCE_KINDS.map((kind) => [
    kind,
    BigInt(result.state.treasury[kind])
      + Object.values(result.state.agents).reduce((sum, agent) => sum + BigInt(agent.resources[kind]), 0n),
  ]));
  assert.deepEqual(actualTotals, expectedTotals);
});
