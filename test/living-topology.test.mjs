import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROTOCOL_TERMS, Universe } from "../dist/index.js";

const objective = primary => ({ primary, secondary: [], antiGoals: [], weights: {} });
const capability = (id, accepts, produces) => ({ id, accepts, produces, riskClass: "low" });
const need = (id, accepts) => ({ id, accepts, priority: 1, recurring: true, maxCommunicationCost: 8, minReliability: 0.5 });
const probation = { requiredInteractions: 2, minStrength: 0.2, timeoutMs: 10_000 };

function makeComplementaryUniverse(extraA = {}, extraB = {}) {
  const universe = new Universe();
  const consumer = universe.createAgent({
    objective: objective("consume signal"),
    capabilities: [capability("consumer", ["signal"], ["ack"])],
    needs: [need("need-signal", ["signal"])],
    exposedState: { request: "ready" },
    networkPolicy: { probation, reviewEveryRevisions: 50 },
    ...extraA
  });
  const producer = universe.createAgent({
    objective: objective("produce signal"),
    capabilities: [capability("producer", ["ack"], ["signal"])],
    exposedState: { signal: 42 },
    networkPolicy: { probation, reviewEveryRevisions: 50 },
    ...extraB
  });
  consumer.activate();
  producer.activate();
  return { universe, consumer, producer };
}

test("agents autonomously discover, negotiate, connect and pass probation", async () => {
  const { universe, consumer, producer } = makeComplementaryUniverse();
  const report = await universe.evolve({
    now: 1_000_000,
    rounds: 1,
    maxLinkTurnsPerRound: 2,
    protocolAdaptation: false
  });

  assert.equal(universe.links.size, 1);
  assert.equal(report.linksCreated.length, 1);
  assert.equal(report.acceptedNegotiations, 1);
  assert.equal(report.synchronizedLinks.length, 1);
  assert.equal(report.linksPromoted.length, 1);

  const link = [...universe.links.values()][0];
  assert.ok(link);
  const snapshot = link.snapshot();
  assert.equal(snapshot.lifecycle, "active");
  assert.equal(snapshot.metrics.successfulSynchronizations, 2);
  assert.deepEqual(snapshot.revisions.filter(revision => revision.kind === "state").map(revision => revision.author), [snapshot.left, snapshot.right]);
  assert.ok(consumer.snapshot().links.includes(snapshot.id));
  assert.ok(producer.snapshot().links.includes(snapshot.id));
  universe.assertIntegrity();
});

test("pairwise negotiation can counteroffer before a link is admitted", async () => {
  const counterBehavior = {
    evaluateOffer: ({ offer }) => {
      if (offer.round === 1 && offer.terms.maxCommunicationCost > 1) {
        return {
          action: "counter",
          reason: "reduce communication budget",
          counterTerms: { ...offer.terms, maxCommunicationCost: 1 }
        };
      }
      return null;
    }
  };
  const { universe } = makeComplementaryUniverse({ behavior: counterBehavior }, { behavior: counterBehavior });
  const report = await universe.evolve({ now: 2_000_000, synchronization: false, protocolAdaptation: false, lifecycleReview: false });

  assert.equal(universe.links.size, 1);
  assert.equal(report.counterOffers, 1);
  assert.equal([...universe.links.values()][0].snapshot().terms.maxCommunicationCost, 1);
  assert.ok(report.events.some(event => event.type === "negotiation_countered"));
});

test("incompatible local worlds do not form a relationship", async () => {
  const universe = new Universe();
  const a = universe.createAgent({
    objective: objective("consume alpha"),
    capabilities: [capability("alpha-consumer", ["alpha"], [])],
    networkPolicy: { minCompatibility: 0.95 }
  });
  const b = universe.createAgent({
    objective: objective("produce beta"),
    capabilities: [capability("beta-producer", [], ["beta"])],
    networkPolicy: { minCompatibility: 0.95 }
  });
  a.activate();
  b.activate();

  const report = await universe.evolve({ now: 3_000_000, synchronization: false, protocolAdaptation: false });
  assert.equal(universe.links.size, 0);
  assert.equal(report.negotiations, 0);
});

test("protocol parameters evolve by the current link turn owner", async () => {
  const adaptiveBehavior = {
    suggestProtocolPatch: ({ link }) => link.terms.payloadMode === "event_only"
      ? null
      : { payloadMode: "event_only", activationMode: "event" }
  };
  const { universe } = makeComplementaryUniverse(
    { behavior: adaptiveBehavior, networkPolicy: { probation, reviewEveryRevisions: 1 } },
    { behavior: adaptiveBehavior, networkPolicy: { probation, reviewEveryRevisions: 1 } }
  );

  await universe.evolve({ now: 4_000_000, rounds: 1, maxLinkTurnsPerRound: 2, protocolAdaptation: false });
  const link = [...universe.links.values()][0];
  assert.ok(link);
  const author = link.currentTurnAgent();

  const report = await universe.evolve({
    now: 4_000_100,
    discovery: false,
    synchronization: false,
    lifecycleReview: false,
    protocolAdaptation: true
  });
  const snapshot = link.snapshot();
  const mutation = snapshot.revisions.findLast(revision => revision.kind === "protocol");
  assert.equal(report.protocolsAdapted.length, 1);
  assert.equal(mutation?.author, author);
  assert.equal(snapshot.terms.payloadMode, "event_only");
  assert.equal(snapshot.terms.activationMode, "event");
  assert.notEqual(link.currentTurnAgent(), author);
});

test("weak dormant links retire and detach from both agents", async () => {
  const universe = new Universe();
  const a = universe.createAgent({ objective: objective("a") });
  const b = universe.createAgent({ objective: objective("b") });
  a.activate();
  b.activate();
  const link = universe.connect({
    left: a.id,
    right: b.id,
    now: 5_000_000,
    strength: 0.05,
    terms: {
      ...DEFAULT_PROTOCOL_TERMS,
      maxIdleMs: 5,
      retireBelowStrength: 0.1,
      decayRate: 0
    }
  });

  await universe.evolve({ now: 5_000_001, discovery: false, synchronization: false, protocolAdaptation: false });
  assert.equal(link.snapshot().lifecycle, "dormant");
  const report = await universe.evolve({ now: 5_000_010, discovery: false, synchronization: false, protocolAdaptation: false });
  assert.equal(universe.links.size, 0);
  assert.ok(report.linksRetired.includes(link.id));
  assert.equal(a.snapshot().links.length, 0);
  assert.equal(b.snapshot().links.length, 0);
});

test("one failing local world does not stop independent links", async () => {
  const universe = new Universe();
  const bad = universe.createAgent({
    objective: objective("bad"),
    behavior: { projectBoundaryState: () => { throw new Error("projection failed"); } }
  });
  const badPeer = universe.createAgent({ objective: objective("bad-peer"), exposedState: { ok: true } });
  const good = universe.createAgent({ objective: objective("good"), exposedState: { value: 1 } });
  const goodPeer = universe.createAgent({ objective: objective("good-peer"), exposedState: { value: 2 } });
  for (const agent of [bad, badPeer, good, goodPeer]) agent.activate();
  universe.connect({ left: bad.id, right: badPeer.id, now: 6_000_000 });
  const goodLink = universe.connect({ left: good.id, right: goodPeer.id, now: 6_000_000 });

  const report = await universe.evolve({
    now: 6_000_001,
    discovery: false,
    protocolAdaptation: false,
    lifecycleReview: false,
    maxLinkTurnsPerRound: 1
  });

  assert.ok(report.errors.some(error => error.entityId === bad.id));
  assert.equal(goodLink.snapshot().metrics.successfulSynchronizations, 1);
  assert.ok(report.synchronizedLinks.includes(goodLink.id));
});

test("a dormant relationship reactivates only when a heartbeat probe finds new boundary information", async () => {
  const universe = new Universe();
  const a = universe.createAgent({ objective: objective("a"), exposedState: { value: 1 } });
  const b = universe.createAgent({ objective: objective("b"), exposedState: { value: 2 } });
  a.activate();
  b.activate();
  const now = 7_000_000;
  const link = universe.connect({
    left: a.id,
    right: b.id,
    now,
    terms: {
      ...DEFAULT_PROTOCOL_TERMS,
      heartbeatMs: 5,
      maxIdleMs: 100,
      retireBelowStrength: 0,
      decayRate: 0
    }
  });
  link.sleep(now);

  const tooEarly = await universe.evolve({
    now: now + 4,
    discovery: false,
    protocolAdaptation: false,
    lifecycleReview: false,
    maxLinkTurnsPerRound: 1
  });
  assert.equal(tooEarly.linksReactivated.length, 0);
  assert.equal(link.snapshot().lifecycle, "dormant");

  a.expose({ value: 3 });
  const report = await universe.evolve({
    now: now + 6,
    discovery: false,
    protocolAdaptation: false,
    lifecycleReview: false,
    maxLinkTurnsPerRound: 1
  });
  assert.ok(report.linksReactivated.includes(link.id));
  assert.notEqual(link.snapshot().lifecycle, "dormant");
  assert.ok(report.events.some(event => event.type === "link_reactivated"));
});

test("independent links advance concurrently while every link remains locally sequential", { timeout: 2_000 }, async () => {
  const universe = new Universe();
  let entered = 0;
  let releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });

  const concurrentBehavior = {
    projectBoundaryState: async ({ self }) => {
      entered += 1;
      if (entered === 2) releaseBarrier();
      let timer;
      try {
        await Promise.race([
          barrier,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("independent links were serialized globally")), 250);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      return self.exposedState;
    }
  };

  const a = universe.createAgent({ objective: objective("a"), exposedState: { value: "a" }, behavior: concurrentBehavior });
  const b = universe.createAgent({ objective: objective("b"), exposedState: { value: "b" } });
  const c = universe.createAgent({ objective: objective("c"), exposedState: { value: "c" }, behavior: concurrentBehavior });
  const d = universe.createAgent({ objective: objective("d"), exposedState: { value: "d" } });
  for (const agent of [a, b, c, d]) agent.activate();

  const first = universe.connect({ left: a.id, right: b.id, now: 8_000_000 });
  const second = universe.connect({ left: c.id, right: d.id, now: 8_000_000 });
  const report = await universe.evolve({
    now: 8_000_001,
    discovery: false,
    lifecycleReview: false,
    protocolAdaptation: false,
    maxLinkTurnsPerRound: 1
  });

  assert.equal(entered, 2);
  assert.deepEqual(new Set(report.synchronizedLinks), new Set([first.id, second.id]));
  assert.equal(report.errors.length, 0);
  assert.equal(first.snapshot().revisions.filter(revision => revision.kind === "state").length, 1);
  assert.equal(second.snapshot().revisions.filter(revision => revision.kind === "state").length, 1);
});
