import test from "node:test";
import assert from "node:assert/strict";
import { Universe, ProtocolViolation } from "../dist/index.js";

const objective=(primary)=>({primary,secondary:[],antiGoals:[],weights:{}});

test("strict alternation prevents one participant from writing twice", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("a")}); const b=u.createAgent({objective:objective("b")});
  const l=u.connect({left:a.id,right:b.id,fieldOwnership:{request:"left",response:"right"}});
  l.mutate({author:a.id,delta:{request:"x"}});
  assert.throws(()=>l.mutate({author:a.id,delta:{request:"y"}}), ProtocolViolation);
  l.mutate({author:b.id,delta:{response:"ok"}});
  assert.equal(l.snapshot().revisions.length,2);
});

test("field ownership is runtime enforced", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("a")}); const b=u.createAgent({objective:objective("b")});
  const l=u.connect({left:a.id,right:b.id,fieldOwnership:{request:"left"}});
  l.mutate({author:a.id,delta:{request:"ok"}});
  assert.throws(()=>l.mutate({author:b.id,delta:{request:"bad"}}), ProtocolViolation);
});

test("clone preserves lineage and advances generation", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("root"),durableState:{knowledge:"x"}}); const c=u.cloneAgent(a.id);
  const s=c.snapshot(); assert.equal(s.generation,1); assert.ok(s.lineage.includes(a.id)); assert.equal(s.durableState.knowledge,"x");
});

test("split creates parallel children and puts parent dormant", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("root")}); a.activate(); const children=u.splitAgent(a.id,[objective("h1"),objective("h2"),objective("h3")]);
  assert.equal(children.length,3); assert.equal(a.lifecycle,"dormant");
});

test("merge combines capabilities and lineage", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("a"),capabilities:[{id:"read",accepts:[],produces:[],riskClass:"low"}]}); const b=u.createAgent({objective:objective("b"),capabilities:[{id:"write",accepts:[],produces:[],riskClass:"medium"}]});
  const m=u.mergeAgents(a.id,b.id,objective("merged")); const ids=m.snapshot().capabilities.map(x=>x.id); assert.deepEqual(ids.sort(),["read","write"]); assert.ok(m.snapshot().lineage.includes(a.id)); assert.ok(m.snapshot().lineage.includes(b.id));
});

test("universe maintains mirrored link integrity", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("a")}); const b=u.createAgent({objective:objective("b")}); const l=u.connect({left:a.id,right:b.id});
  assert.doesNotThrow(()=>u.assertIntegrity()); assert.deepEqual(u.neighbors(a.id),[b.id]); u.disconnect(l.id); assert.equal(u.projection().edges,0);
});

test("link strength grows from useful interaction and decays", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("a")}); const b=u.createAgent({objective:objective("b")}); const l=u.connect({left:a.id,right:b.id,decayRate:0.01});
  l.mutate({author:a.id,delta:{x:1},informationGain:2,utility:3}); l.mutate({author:b.id,delta:{y:2},informationGain:2,utility:3}); const before=l.snapshot().strength;
  l.decay(Date.now()+1000); assert.ok(l.snapshot().strength < before);
});

test("strong-link connected components emerge as clusters", () => {
  const u=new Universe(); const a=u.createAgent({objective:objective("a")}); const b=u.createAgent({objective:objective("b")}); const c=u.createAgent({objective:objective("c")});
  const ab=u.connect({left:a.id,right:b.id});
  ab.mutate({author:a.id,delta:{x:1},informationGain:10,utility:10}); ab.mutate({author:b.id,delta:{y:1},informationGain:10,utility:10});
  const clusters=u.detectClusters(0.4); assert.ok(clusters.some(x=>x.includes(a.id)&&x.includes(b.id))); assert.ok(clusters.some(x=>x.length===1&&x[0]===c.id));
});

const reciprocalAgents = (u, overrides = {}) => {
  const commonPolicy = overrides.networkPolicy ?? {};
  const behavior = overrides.behavior;
  const left = u.createAgent({
    objective: objective("consume signal"),
    capabilities: [{ id: "consumer", accepts: ["signal.result"], produces: ["signal.request"], riskClass: "low" }],
    needs: [{ id: "need-result", accepts: ["signal.result"], priority: 1, recurring: true, maxCommunicationCost: 8, minReliability: 0.5 }],
    networkPolicy: commonPolicy,
    ...(behavior ? { behavior } : {}),
    exposedState: { request: "r1" }
  });
  const right = u.createAgent({
    objective: objective("produce signal"),
    capabilities: [{ id: "producer", accepts: ["signal.request"], produces: ["signal.result"], riskClass: "low" }],
    needs: [{ id: "need-request", accepts: ["signal.request"], priority: 1, recurring: true, maxCommunicationCost: 8, minReliability: 0.5 }],
    networkPolicy: commonPolicy,
    ...(behavior ? { behavior } : {}),
    exposedState: { result: "ok" }
  });
  left.activate();
  right.activate();
  return { left, right };
};

test("nanoagents discover each other, negotiate, synchronize, and promote their own link", async () => {
  const u = new Universe();
  reciprocalAgents(u);

  const report = await u.evolve({ rounds: 2, maxLinkTurnsPerRound: 2, stepMs: 10 });
  assert.equal(u.projection().edges, 1);
  assert.equal(report.acceptedNegotiations, 1);
  assert.equal(report.linksCreated.length, 1);
  assert.equal(report.linksPromoted.length, 1);

  const link = [...u.links.values()][0];
  assert.ok(link);
  const snapshot = link.snapshot();
  assert.deepEqual(snapshot.state.left, u.requireAgent(snapshot.left).snapshot().exposedState);
  assert.deepEqual(snapshot.state.right, u.requireAgent(snapshot.right).snapshot().exposedState);
  const stateRevisions = snapshot.revisions.filter(revision => revision.kind === "state");
  assert.equal(stateRevisions.length, 2);
  assert.equal(stateRevisions[0].author, snapshot.left);
  assert.equal(stateRevisions[1].author, snapshot.right);
  assert.doesNotThrow(() => u.assertIntegrity());

  const leftObserved = u.requireAgent(snapshot.left).snapshot().ephemeralState.observedBoundaries;
  const rightObserved = u.requireAgent(snapshot.right).snapshot().ephemeralState.observedBoundaries;
  assert.ok(leftObserved && rightObserved);
});

test("incompatible nanoagents do not form a relationship", async () => {
  const u = new Universe();
  const a = u.createAgent({
    objective: objective("alpha"),
    capabilities: [{ id: "alpha", accepts: ["alpha.in"], produces: ["alpha.out"], riskClass: "low" }]
  });
  const b = u.createAgent({
    objective: objective("beta"),
    capabilities: [{ id: "beta", accepts: ["beta.in"], produces: ["beta.out"], riskClass: "low" }]
  });
  a.activate();
  b.activate();
  const report = await u.evolve({ rounds: 3 });
  assert.equal(u.projection().edges, 0);
  assert.equal(report.acceptedNegotiations, 0);
});

test("pairwise handshake supports alternating counteroffers", async () => {
  const u = new Universe();
  const behavior = {
    evaluateOffer: ({ offer }) => offer.round === 1
      ? { action: "counter", reason: "request a shorter heartbeat", counterTerms: { ...offer.terms, heartbeatMs: 5_000 } }
      : null
  };
  reciprocalAgents(u, { behavior });
  const report = await u.evolve({ rounds: 1, synchronization: false, lifecycleReview: false });
  assert.equal(report.counterOffers, 1);
  assert.equal(report.acceptedNegotiations, 1);
  assert.equal(u.projection().edges, 1);
  assert.equal([...u.links.values()][0].snapshot().terms.heartbeatMs, 5_000);
});

test("local policy can reject a proposed relationship without central arbitration", async () => {
  const u = new Universe();
  const behavior = { evaluateOffer: () => ({ action: "reject", reason: "local policy refuses this peer" }) };
  reciprocalAgents(u, { behavior });
  const report = await u.evolve({ rounds: 1, synchronization: false, lifecycleReview: false });
  assert.equal(u.projection().edges, 0);
  assert.equal(report.rejectedNegotiations.length, 1);
  assert.ok(report.events.some(event => event.type === "negotiation_rejected"));
});

test("protocol parameters evolve through a pairwise negotiated turn", async () => {
  const u = new Universe();
  reciprocalAgents(u, { networkPolicy: { reviewEveryRevisions: 1 } });
  const report = await u.evolve({ rounds: 3, maxLinkTurnsPerRound: 2, stepMs: 10 });
  assert.equal(u.projection().edges, 1);
  assert.equal(report.protocolsAdapted.length, 1);
  const link = [...u.links.values()][0];
  const protocolRevisions = link.snapshot().revisions.filter(revision => revision.kind === "protocol");
  assert.ok(protocolRevisions.length >= 2);
  assert.ok(protocolRevisions.every(revision => revision.evidence.some(item => item.startsWith("negotiation:"))));
  for (let index = 1; index < protocolRevisions.length; index += 1) {
    assert.notEqual(protocolRevisions[index - 1].author, protocolRevisions[index].author);
  }
});

test("protocol mutation rights alternate between participants", () => {
  const u = new Universe();
  const a = u.createAgent({ objective: objective("a") });
  const b = u.createAgent({ objective: objective("b") });
  const link = u.connect({ left: a.id, right: b.id });
  const snapshot = link.snapshot();
  const first = snapshot.turnOwner === "left" ? snapshot.left : snapshot.right;
  const second = first === snapshot.left ? snapshot.right : snapshot.left;
  link.mutateProtocol(first, { heartbeatMs: 12_000 });
  assert.throws(() => link.mutateProtocol(first, { heartbeatMs: 11_000 }), ProtocolViolation);
  assert.doesNotThrow(() => link.mutateProtocol(second, { heartbeatMs: 10_000 }));
});

test("weak dormant relationships retire and detach from both agents", async () => {
  const u = new Universe();
  const a = u.createAgent({ objective: objective("a") });
  const b = u.createAgent({ objective: objective("b") });
  const link = u.connect({
    left: a.id,
    right: b.id,
    decayRate: 0.01,
    terms: {
      mode: "strict_alternation",
      fieldOwnership: { left: "left", right: "right" },
      payloadMode: "delta",
      activationMode: "event",
      minActivationIntervalMs: 0,
      heartbeatMs: 30_000,
      triggers: [],
      minInformationGain: 0,
      maxCommunicationCost: 8,
      decayRate: 0.01,
      maxIdleMs: 1,
      retireBelowStrength: 0.09,
      reviewEveryRevisions: 10,
      probation: { requiredInteractions: 1, minStrength: 0, timeoutMs: 100 }
    }
  });
  const future = Date.now() + 1_000;
  await u.evolve({ rounds: 1, now: future, discovery: false, synchronization: false, protocolAdaptation: false });
  assert.equal(link.snapshot().lifecycle, "dormant");
  const report = await u.evolve({ rounds: 1, now: future + 10, discovery: false, synchronization: false, protocolAdaptation: false });
  assert.ok(report.linksRetired.includes(link.id));
  assert.equal(u.projection().edges, 0);
  assert.equal(a.snapshot().links.length, 0);
  assert.equal(b.snapshot().links.length, 0);
});
