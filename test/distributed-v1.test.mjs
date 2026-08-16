import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnthropicProvider,
  ByzantineQuorum,
  CryptoIdentity,
  DistributedGraphNode,
  FractalUniverse,
  IdentityRegistry,
  LlmRouter,
  OllamaProvider,
  OpenAICompatibleProvider,
  PersistentGraphStore,
  ReplayWindow,
  ResourceLedger,
  ResourceMarket,
  SecureTransport,
  TcpTransport,
  canonicalJson,
  createGraphCommand,
} from "../dist/v1/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail("condition was not reached before timeout");
}

function committeeFixture() {
  const identities = [0, 1, 2, 3].map((index) => CryptoIdentity.generate(`r${index}`));
  const members = identities.map((identity) => identity.publicIdentity());
  return { identities, members };
}

test("canonical JSON is stable across object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: { z: 1, y: true } }), canonicalJson({ a: { y: true, z: 1 }, b: 2 }));
});

test("Ed25519 identity signs envelopes and replay protection rejects a nonce twice", () => {
  const identity = CryptoIdentity.generate("alice");
  const registry = new IdentityRegistry({ replayWindow: new ReplayWindow(60_000) });
  registry.register(identity.publicIdentity());
  const envelope = identity.sign("test", { value: 7 }, { now: 10_000, nonce: "one" });
  assert.equal(registry.verify(envelope, { now: 10_000 }), true);
  assert.equal(registry.verify(envelope, { now: 10_000 }), false);
});

test("identity registry rejects signature and payload tampering", () => {
  const identity = CryptoIdentity.generate("alice");
  const registry = new IdentityRegistry();
  registry.register(identity.publicIdentity());
  const envelope = identity.sign("test", { value: 7 });
  const tampered = { ...envelope, payload: { value: 8 } };
  assert.equal(registry.verify(tampered, { consumeNonce: false }), false);
});

test("TCP transport exchanges a length-framed message over a real socket", async () => {
  const receiver = new TcpTransport();
  const address = await receiver.start({ host: "127.0.0.1", port: 0 });
  const received = new Promise((resolve) => receiver.onMessage(({ bytes }) => resolve(Buffer.from(bytes).toString("utf8"))));
  const sender = new TcpTransport();
  await sender.send(address, Buffer.from("hello over tcp"));
  assert.equal(await received, "hello over tcp");
  await receiver.stop();
});

test("secure transport authenticates a remote machine before dispatch", async () => {
  const alice = CryptoIdentity.generate("alice");
  const bob = CryptoIdentity.generate("bob");
  const aliceRegistry = new IdentityRegistry();
  const bobRegistry = new IdentityRegistry();
  aliceRegistry.register(alice.publicIdentity());
  aliceRegistry.register(bob.publicIdentity());
  bobRegistry.register(alice.publicIdentity());
  bobRegistry.register(bob.publicIdentity());
  const aliceTcp = new TcpTransport();
  const bobTcp = new TcpTransport();
  await aliceTcp.start({ host: "127.0.0.1", port: 0 });
  const bobAddress = await bobTcp.start({ host: "127.0.0.1", port: 0 });
  const aliceSecure = new SecureTransport(alice, aliceRegistry, aliceTcp);
  const bobSecure = new SecureTransport(bob, bobRegistry, bobTcp);
  const received = new Promise((resolve) => bobSecure.onEnvelope(resolve));
  await aliceSecure.send(bobAddress, "boundary.delta", { status: "ready" }, bob.id);
  const envelope = await received;
  assert.equal(envelope.sender, "alice");
  assert.deepEqual(envelope.payload, { status: "ready" });
  aliceSecure.close();
  bobSecure.close();
  await aliceTcp.stop();
  await bobTcp.stop();
});

test("persistent graph restores a snapshot and replays later WAL records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-store-"));
  const store = new PersistentGraphStore(directory);
  const reduce = (state, command) => ({ count: state.count + command.payload.delta });
  await store.append({ id: "a", type: "increment", payload: { delta: 2 }, issuedAt: 1, issuer: "n" });
  let recovered = await store.recover({ count: 0 }, reduce);
  assert.equal(recovered.state.count, 2);
  await store.checkpoint(recovered.state);
  await store.append({ id: "b", type: "increment", payload: { delta: 3 }, issuedAt: 2, issuer: "n" });
  const restarted = new PersistentGraphStore(directory);
  recovered = await restarted.recover({ count: 0 }, reduce);
  assert.equal(recovered.state.count, 5);
  assert.equal(recovered.replayed, 1);
});

test("persistent graph detects WAL tampering instead of recovering corrupted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anu-tamper-"));
  const store = new PersistentGraphStore(directory);
  await store.append({ id: "a", type: "increment", payload: { delta: 2 }, issuedAt: 1, issuer: "n" });
  const path = join(directory, "graph.wal.jsonl");
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace('"delta":2', '"delta":9'), "utf8");
  const restarted = new PersistentGraphStore(directory);
  await assert.rejects(() => restarted.recover({ count: 0 }, (state, command) => ({ count: state.count + command.payload.delta })), /checksum mismatch/);
});

test("Byzantine quorum commits only with 2f+1 unique signatures", () => {
  const { identities, members } = committeeFixture();
  const quorum = new ByzantineQuorum(members);
  const command = { id: "c1", type: "agent.upsert", payload: { value: 1 }, issuedAt: 1, issuer: "r0" };
  const proposal = quorum.proposal(identities[0], 1, command);
  const votes = identities.slice(0, 3).map((identity) => quorum.vote(identity, proposal));
  const certificate = quorum.certify(proposal, votes);
  assert.equal(certificate.quorum, 3);
  assert.equal(quorum.verifyCertificate(certificate), true);
});

test("Byzantine quorum rejects duplicated voters and a forged payload", () => {
  const { identities, members } = committeeFixture();
  const quorum = new ByzantineQuorum(members);
  const command = { id: "c1", type: "agent.upsert", payload: { value: 1 }, issuedAt: 1, issuer: "r0" };
  const proposal = quorum.proposal(identities[0], 1, command);
  const oneVote = quorum.vote(identities[0], proposal);
  assert.throws(() => quorum.certify(proposal, [oneVote, oneVote, oneVote]), /quorum not reached/i);
  assert.equal(quorum.verifyProposal({ ...proposal, command: { ...command, payload: { value: 2 } } }), false);
});

test("BFT view change elects the next deterministic leader after quorum timeout votes", () => {
  const { identities, members } = committeeFixture();
  const quorum = new ByzantineQuorum(members);
  assert.equal(quorum.leader(), "r0");
  const changes = identities.slice(0, 3).map((identity) => quorum.viewChange(identity, "leader timeout", 1));
  assert.equal(quorum.advanceView(changes), 1);
  assert.equal(quorum.leader(), "r1");
});

test("resource ledger is double-entry, non-negative and conserved", () => {
  const ledger = new ResourceLedger();
  ledger.mint("buyer", "credits", 1_000);
  ledger.transfer("buyer", "seller", "credits", 125, "payment");
  assert.equal(ledger.balance("buyer", "credits"), 875);
  assert.equal(ledger.balance("seller", "credits"), 125);
  assert.equal(ledger.assertConserved("credits"), true);
  assert.throws(() => ledger.transfer("buyer", "seller", "credits", 10_000, "overspend"), /insufficient/);
});

test("resource market escrows credits and atomically settles delivered compute", () => {
  const ledger = new ResourceLedger();
  ledger.mint("buyer", "credits", 1_000);
  ledger.mint("seller", "compute_ms", 100);
  const market = new ResourceMarket(ledger);
  market.placeOffer({ seller: "seller", resource: "compute_ms", quantity: 50, unitPrice: 2, minimumFill: 1, expiresAt: Date.now() + 10_000 });
  market.placeBid({ buyer: "buyer", resource: "compute_ms", quantity: 20, maxUnitPrice: 3, expiresAt: Date.now() + 10_000 });
  const [trade] = market.match();
  assert.equal(trade.state, "escrowed");
  market.settle(trade.id);
  assert.equal(ledger.balance("buyer", "compute_ms"), 20);
  assert.equal(ledger.balance("seller", "credits"), 40);
});

test("OpenAI-compatible provider maps HTTP responses into a provider-neutral result", async () => {
  const mockFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  const provider = new OpenAICompatibleProvider({ defaultModel: "test-model", apiKey: "test" }, mockFetch);
  const response = await provider.complete({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(response.content, "ok");
  assert.equal(response.usage.totalTokens, 5);
});

test("LLM router falls back between providers without coupling agents to a vendor", async () => {
  const router = new LlmRouter();
  router.register({
    id: "broken",
    capabilities: new Set(["chat"]),
    estimatedInputCostPerMillion: 1,
    estimatedOutputCostPerMillion: 1,
    health: () => ({ healthy: true, consecutiveFailures: 0 }),
    complete: async () => { throw new Error("offline"); },
  });
  router.register({
    id: "working",
    capabilities: new Set(["chat"]),
    estimatedInputCostPerMillion: 2,
    estimatedOutputCostPerMillion: 2,
    health: () => ({ healthy: true, consecutiveFailures: 0 }),
    complete: async () => ({ provider: "working", model: "m", content: "fallback", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, latencyMs: 1 }),
  });
  const result = await router.complete({ messages: [{ role: "user", content: "hello" }] }, { require: ["chat"], prefer: ["broken", "working"] });
  assert.equal(result.provider, "working");
});

test("fractal universe folds, rewires and reversibly unfolds a strong cluster", () => {
  const universe = new FractalUniverse();
  universe.addAgent({ id: "a", capabilities: ["sense"], exposedState: {} });
  universe.addAgent({ id: "b", capabilities: ["decide"], exposedState: {} });
  universe.addAgent({ id: "outside", capabilities: ["act"], exposedState: {} });
  universe.addLink({ id: "ab", left: "a", right: "b", protocol: {}, strength: 0.9 });
  universe.addLink({ id: "bo", left: "b", right: "outside", protocol: {}, strength: 0.8 });
  const meta = universe.foldCluster(["a", "b"], "meta:ab");
  assert.deepEqual(meta.capabilities, ["decide", "sense"]);
  assert.equal(universe.projection().links.find((link) => link.id === "bo").left, "meta:ab");
  universe.unfold("meta:ab");
  assert.equal(universe.projection().links.find((link) => link.id === "bo").left, "b");
});

test("metaagents can recursively fold into higher-order metaagents", () => {
  const universe = new FractalUniverse();
  for (const id of ["a", "b", "c"]) universe.addAgent({ id, capabilities: [id], exposedState: {} });
  universe.addLink({ left: "a", right: "b", protocol: {}, strength: 0.9 });
  const first = universe.foldCluster(["a", "b"], "meta:first");
  universe.addLink({ left: first.id, right: "c", protocol: {}, strength: 0.9 });
  const second = universe.foldCluster([first.id, "c"], "meta:second");
  assert.equal(second.depth, 2);
  universe.unfold(second.id);
  assert.ok(universe.getMetaAgent(first.id));
});

test("distributed nodes replicate a BFT-certified graph command and recover after restart", async () => {
  const { identities, members } = committeeFixture();
  const replicaDirectory = await mkdtemp(join(tmpdir(), "anu-replica-"));
  const leaderDirectory = await mkdtemp(join(tmpdir(), "anu-leader-"));
  const replica = new DistributedGraphNode({ identity: identities[1], committee: members, storageDirectory: replicaDirectory, listen: { host: "127.0.0.1", port: 0 } });
  const replicaAddress = await replica.start();
  const leader = new DistributedGraphNode({
    identity: identities[0],
    committee: members,
    storageDirectory: leaderDirectory,
    listen: { host: "127.0.0.1", port: 0 },
    peers: [{ id: identities[1].id, address: replicaAddress, identity: identities[1].publicIdentity() }],
  });
  await leader.start();
  const command = createGraphCommand("r0", "agent.upsert", {
    agent: { id: "nano:one", kind: "nano", capabilities: ["observe"], exposedState: { status: "ready" }, lineage: [] },
  });
  const certificate = leader.buildCertificate(command, identities.slice(0, 3));
  await leader.commit(certificate);
  await eventually(() => replica.state.sequence === 1);
  assert.equal(replica.state.graph.agents[0].id, "nano:one");
  await replica.checkpoint();
  await replica.stop();
  const restarted = new DistributedGraphNode({ identity: identities[1], committee: members, storageDirectory: replicaDirectory, listen: { host: "127.0.0.1", port: 0 } });
  await restarted.start();
  assert.equal(restarted.state.sequence, 1);
  assert.equal(restarted.state.graph.agents[0].id, "nano:one");
  await restarted.stop();
  await leader.stop();
});
