import test from "node:test";
import assert from "node:assert/strict";
import { Universe, ProtocolViolation } from "../src/index.js";

const objective=(primary:string)=>({primary,secondary:[],antiGoals:[],weights:{}});

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
  assert.throws(()=>l.mutate({author:a.id,delta:{request:"ok"}}) && l.mutate({author:b.id,delta:{request:"bad"}}));
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
  const ab=u.connect({left:a.id,right:b.id,strength:0.9}); ab.recalculateStrength = ab.recalculateStrength.bind(ab); // keep API exercised
  // interact enough to produce a useful edge
  ab.mutate({author:a.id,delta:{x:1},informationGain:10,utility:10}); ab.mutate({author:b.id,delta:{y:1},informationGain:10,utility:10});
  const clusters=u.detectClusters(0.4); assert.ok(clusters.some(x=>x.includes(a.id)&&x.includes(b.id))); assert.ok(clusters.some(x=>x.length===1&&x[0]===c.id));
});
