import test from "node:test";
import assert from "node:assert/strict";
import { createGenesisAgents } from "../dist/lab/agent-factory.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { createLabEvent, initialEventHash } from "../dist/lab/events.js";
import { deterministicId } from "../dist/lab/ids.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import { applyWorldEventMutable, initialWorldState, prepareWorldEventTransition } from "../dist/lab/reducer.js";

function resources(value) {
  return {
    credits: value,
    llmTokens: value,
    computeMs: value,
    storageBytes: value,
    bandwidthBytes: value,
  };
}

function fixture(seed) {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = seed;
  config.agents = 2;
  config.ticks = 4;
  config.initialResources = resources(1_000);
  config.treasuryResources = resources(1_000);
  const manifest = createRunManifest(config, "U0001");
  const agents = createGenesisAgents(config);
  const state = initialWorldState(manifest);
  state.started = true;
  for (const agent of agents) state.agents[agent.id] = agent;
  const makeEvent = (draft, seq = 1, previousHash = initialEventHash(manifest)) => (
    createLabEvent(manifest, draft, seq, previousHash)
  );
  return { config, manifest, agents, state, makeEvent };
}

function availableTask(id = "task:00000001:0000000000") {
  return {
    id,
    family: "arithmetic",
    input: { operation: "add", left: 1, right: 2 },
    createdTick: 1,
    deadlineTick: 3,
    status: "available",
  };
}

test("logical v1.1 enforces agent and task lifecycle transitions", () => {
  const retired = fixture("retirement-provenance");
  const [first] = retired.agents;
  const badRetiredTick = retired.makeEvent({
    tick: 1,
    phase: "pressure",
    type: "agent.retired",
    actorId: first.id,
    causationId: "pressure:event",
    data: { agentId: first.id, retiredTick: 2, reason: "pressure" },
  });
  assert.throws(
    () => prepareWorldEventTransition(retired.state, badRetiredTick),
    /retiredTick must equal/,
  );
  const validRetirement = retired.makeEvent({
    tick: 1,
    phase: "pressure",
    type: "agent.retired",
    actorId: first.id,
    causationId: "pressure:event",
    data: { agentId: first.id, retiredTick: 1, reason: "pressure" },
  });
  applyWorldEventMutable(retired.state, validRetirement);
  assert.equal(retired.state.agents[first.id].active, false);
  assert.equal(retired.state.agents[first.id].retiredTick, 1);
  const duplicateRetirement = retired.makeEvent({
    tick: 2,
    phase: "pressure",
    type: "agent.retired",
    actorId: first.id,
    causationId: "pressure:event",
    data: { agentId: first.id, retiredTick: 2, reason: "pressure" },
  }, 2, validRetirement.hash);
  assert.throws(
    () => prepareWorldEventTransition(retired.state, duplicateRetirement),
    /already inactive/,
  );

  for (const [mutate, expected] of [
    [(task) => { task.status = "completed"; }, /must start available/],
    [(task) => { task.createdTick = 0; }, /createdTick must equal/],
    [(task) => { task.deadlineTick = task.createdTick; }, /must be after/],
    [(task) => { task.family = "forged"; }, /Unknown task family/],
  ]) {
    const created = fixture(`task-created-${String(expected)}`);
    const task = availableTask();
    mutate(task);
    const event = created.makeEvent({
      tick: 1,
      phase: "task_generation",
      type: "task.created",
      data: { task },
    });
    assert.throws(() => prepareWorldEventTransition(created.state, event), expected);
  }

  const expiry = fixture("task-expiry");
  const task = availableTask();
  expiry.state.tasks[task.id] = task;
  const earlyExpiry = expiry.makeEvent({
    tick: task.deadlineTick,
    phase: "task_generation",
    type: "task.expired",
    data: { taskId: task.id },
  });
  assert.throws(() => prepareWorldEventTransition(expiry.state, earlyExpiry), /before its deadline passes/);
  task.status = "submitted";
  const submittedExpiry = expiry.makeEvent({
    tick: task.deadlineTick + 1,
    phase: "task_generation",
    type: "task.expired",
    data: { taskId: task.id },
  });
  assert.throws(() => prepareWorldEventTransition(expiry.state, submittedExpiry), /cannot expire/);

  const learning = fixture("derived-learning");
  const forgedLearning = learning.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "agent.learning.updated",
    actorId: learning.agents[0].id,
    data: { agentId: learning.agents[0].id, family: "arithmetic", attempts: 999, successes: 999, utilityPpm: 1_000_000 },
  });
  assert.throws(
    () => prepareWorldEventTransition(learning.state, forgedLearning),
    /learning is derived from task.evaluated/,
  );
});

test("logical v1.1 derives submission, evaluation, verification, and reward provenance", () => {
  const run = fixture("task-provenance");
  const [owner, verifier] = run.agents;
  const task = availableTask();
  task.createdTick = 0;
  task.status = "claimed";
  task.claimedBy = owner.id;
  run.state.tasks[task.id] = task;

  const submissionSeq = 7;
  const submissionId = deterministicId("submission", run.manifest.runId, task.id, owner.id);
  const submittedEventId = deterministicId(
    "event", run.manifest.runId, run.manifest.universeId, submissionSeq,
  );
  const submission = {
    id: submissionId,
    taskId: task.id,
    agentId: owner.id,
    result: 3,
    submittedTick: 1,
    submittedSeq: submissionSeq,
    submittedEventId,
    accepted: false,
    qualityPpm: 0,
    latencyTicks: 0,
  };
  const forgedSubmission = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "task.submitted",
    actorId: verifier.id,
    causationId: "payment:event",
    data: { submission },
  }, submissionSeq);
  assert.throws(
    () => prepareWorldEventTransition(run.state, forgedSubmission),
    /actorId must match submission.agentId/,
  );

  const validSubmission = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "task.submitted",
    actorId: owner.id,
    causationId: "payment:event",
    data: { submission },
  }, submissionSeq);
  applyWorldEventMutable(run.state, validSubmission);
  assert.equal(run.state.submissions[submissionId].submittedEventId, validSubmission.eventId);

  const prematureVerification = run.makeEvent({
    tick: 2,
    phase: "resolution",
    type: "submission.verified",
    actorId: verifier.id,
    targetId: owner.id,
    causationId: "payment:verify",
    data: {
      verification: {
        id: deterministicId("verification", run.manifest.runId, submissionId, verifier.id),
        submissionId,
        verifierId: verifier.id,
        computedResult: 3,
        verdict: true,
        matchesSubmission: true,
        createdTick: 2,
      },
    },
  }, submissionSeq + 1, validSubmission.hash);
  assert.throws(
    () => prepareWorldEventTransition(run.state, prematureVerification),
    /Only completed, evaluated tasks/,
  );

  const inconsistentEvaluation = run.makeEvent({
    tick: 2,
    phase: "evaluation",
    type: "task.evaluated",
    actorId: owner.id,
    causationId: validSubmission.eventId,
    data: {
      taskId: task.id,
      submissionId,
      accepted: true,
      qualityPpm: 0,
      latencyTicks: 2,
      completedTick: 2,
      violations: 0,
    },
  }, submissionSeq + 1, validSubmission.hash);
  assert.throws(
    () => prepareWorldEventTransition(run.state, inconsistentEvaluation),
    /accepted and qualityPpm are inconsistent/,
  );

  const evaluated = run.makeEvent({
    tick: 2,
    phase: "evaluation",
    type: "task.evaluated",
    actorId: owner.id,
    causationId: validSubmission.eventId,
    data: {
      taskId: task.id,
      submissionId,
      accepted: true,
      qualityPpm: 1_000_000,
      latencyTicks: 2,
      completedTick: 2,
      violations: 0,
    },
  }, submissionSeq + 1, validSubmission.hash);
  applyWorldEventMutable(run.state, evaluated);

  const forgedReward = run.makeEvent({
    tick: 2,
    phase: "evaluation",
    type: "resource.transferred",
    actorId: "@treasury",
    targetId: verifier.id,
    causationId: evaluated.eventId,
    data: {
      fromId: "@treasury",
      toId: verifier.id,
      resource: "credits",
      amount: 1,
      reason: "accepted-task",
      taskId: task.id,
    },
  }, submissionSeq + 2, evaluated.hash);
  assert.throws(
    () => prepareWorldEventTransition(run.state, forgedReward),
    /recipient must own an accepted submission/,
  );
  const wrongRewardCause = run.makeEvent({
    tick: 2,
    phase: "evaluation",
    type: "resource.transferred",
    actorId: "@treasury",
    targetId: owner.id,
    causationId: validSubmission.eventId,
    data: {
      fromId: "@treasury",
      toId: owner.id,
      resource: "credits",
      amount: 1,
      reason: "accepted-task",
      taskId: task.id,
    },
  }, submissionSeq + 2, evaluated.hash);
  assert.throws(
    () => prepareWorldEventTransition(run.state, wrongRewardCause),
    /must be caused by its task.evaluated event/,
  );
});

test("messages resolve synchronously through the exact active link", () => {
  const run = fixture("message-state-machine");
  const [sender, recipient] = run.agents;
  const [left, right] = [sender.id, recipient.id].sort();
  const linkId = deterministicId("link", run.manifest.runId, left, right);
  run.state.links[linkId] = {
    id: linkId,
    left,
    right,
    strengthPpm: 1_000_000,
    createdTick: 0,
    lastUsedTick: 0,
  };
  const sentSeq = 10;
  const sentEventId = deterministicId("event", run.manifest.runId, run.manifest.universeId, sentSeq);
  const messageId = deterministicId(
    "message", run.manifest.runId, run.manifest.universeId, 1, sender.id, recipient.id, 0,
  );
  const sent = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "message.sent",
    actorId: sender.id,
    targetId: recipient.id,
    causationId: "payment:send",
    data: {
      message: {
        id: messageId,
        senderId: sender.id,
        recipientId: recipient.id,
        payload: { value: 1 },
        sentTick: 1,
        sentSeq,
        sentEventId,
        linkId,
        localIndex: 0,
      },
    },
  }, sentSeq);
  applyWorldEventMutable(run.state, sent);
  assert.equal(run.state.messages[messageId].sentSeq, sentSeq);
  assert.equal(run.state.messages[messageId].linkId, linkId);

  const lateDelivery = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "message.delivered",
    actorId: sender.id,
    targetId: recipient.id,
    causationId: sent.eventId,
    data: { messageId, linkId },
  }, sentSeq + 2, sent.hash);
  assert.throws(
    () => prepareWorldEventTransition(run.state, lateDelivery),
    /must be delivered immediately/,
  );
  const delivered = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "message.delivered",
    actorId: sender.id,
    targetId: recipient.id,
    causationId: sent.eventId,
    data: { messageId, linkId },
  }, sentSeq + 1, sent.hash);
  applyWorldEventMutable(run.state, delivered);

  const wrongUseCause = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "link.used",
    actorId: sender.id,
    targetId: recipient.id,
    causationId: sent.eventId,
    data: { messageId, linkId },
  }, sentSeq + 2, delivered.hash);
  assert.throws(
    () => prepareWorldEventTransition(run.state, wrongUseCause),
    /must be caused by message.delivered/,
  );
  const used = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "link.used",
    actorId: sender.id,
    targetId: recipient.id,
    causationId: delivered.eventId,
    data: { messageId, linkId },
  }, sentSeq + 2, delivered.hash);
  const forgedStrength = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "link.used",
    actorId: sender.id,
    targetId: recipient.id,
    causationId: delivered.eventId,
    data: { messageId, linkId, strengthPpm: 0 },
  }, sentSeq + 2, delivered.hash);
  assert.throws(
    () => prepareWorldEventTransition(run.state, forgedStrength),
    /must contain exactly/,
    "link usage cannot smuggle a state-changing strength override",
  );
  applyWorldEventMutable(run.state, used);
  assert.equal(run.state.messages[messageId].linkUsedEventId, used.eventId);
});

test("resource, memory, and violation events cannot forge actor/data provenance", () => {
  const run = fixture("actor-data-provenance");
  const [first, second] = run.agents;
  const forgedSpend = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "resource.spent",
    actorId: first.id,
    data: { agentId: second.id, action: "store", cost: resources(0) },
  });
  assert.throws(() => prepareWorldEventTransition(run.state, forgedSpend), /actorId must match data.agentId/);

  const forgedTransfer = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "resource.transferred",
    actorId: second.id,
    targetId: second.id,
    causationId: "payment:transfer",
    data: { fromId: first.id, toId: second.id, resource: "credits", amount: 1 },
  });
  assert.throws(
    () => prepareWorldEventTransition(run.state, forgedTransfer),
    /actor\/target must exactly match/,
  );

  const forgedMemory = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "memory.stored",
    actorId: first.id,
    causationId: "payment:store",
    data: { agentId: second.id, action: "store", key: "x", value: 1 },
  });
  assert.throws(() => prepareWorldEventTransition(run.state, forgedMemory), /actorId must match data.agentId/);

  const targetedViolation = run.makeEvent({
    tick: 1,
    phase: "resolution",
    type: "violation.recorded",
    actorId: first.id,
    targetId: second.id,
    data: { agentId: first.id, action: "reason", reason: "forged", count: 1 },
  });
  assert.throws(() => prepareWorldEventTransition(run.state, targetedViolation), /cannot have targetId/);
});
