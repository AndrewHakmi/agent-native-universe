#!/usr/bin/env node
import { Universe } from "../runtime/universe.js";

const [command] = process.argv.slice(2);

if (!command || command === "help") {
  console.log(`Agent Native Universe (anu)

Commands:
  anu demo         run a manually connected two-agent demo
  anu living       let agents discover and form topology autonomously
  anu living-demo  alias for anu living
  anu principles   print core runtime laws`);
  process.exit(0);
}

if (command === "principles") {
  console.log([
    "1. Local worlds, explicit boundaries.",
    "2. Edges are stateful computational objects.",
    "3. Local sequential consistency; global parallelism.",
    "4. Hard invariants are runtime-enforced, not prompt-enforced.",
    "5. Topology and architecture are projections of the live graph.",
    "6. Peer choice is local and relationship admission is pairwise.",
    "7. No mandatory central orchestrator."
  ].join("\n"));
  process.exit(0);
}

const objective = (primary: string) => ({ primary, secondary: [], antiGoals: [], weights: {} });

if (command === "demo") {
  const universe = new Universe();
  const observer = universe.createAgent({ objective: objective("observe") });
  const responder = universe.createAgent({ objective: objective("respond") });
  observer.activate();
  responder.activate();
  const link = universe.connect({
    left: observer.id,
    right: responder.id,
    fieldOwnership: { signal: "left", reply: "right" }
  });
  link.mutate({ author: observer.id, delta: { signal: "ping" }, informationGain: 1 });
  link.mutate({ author: responder.id, delta: { reply: "pong" }, utility: 1 });
  console.log(JSON.stringify({ projection: universe.projection(), link: link.snapshot() }, null, 2));
  process.exit(0);
}

if (command === "living" || command === "living-demo") {
  const universe = new Universe();
  const consumer = universe.createAgent({
    objective: objective("consume signal"),
    capabilities: [{ id: "consumer", accepts: ["signal"], produces: ["ack"], riskClass: "low" }],
    needs: [{ id: "need.signal", accepts: ["signal"], priority: 1, recurring: true, maxCommunicationCost: 8, minReliability: 0.5 }],
    exposedState: { request: "signal" }
  });
  const producer = universe.createAgent({
    objective: objective("produce signal"),
    capabilities: [{ id: "producer", accepts: ["ack"], produces: ["signal"], riskClass: "low" }],
    exposedState: { signal: "hello" }
  });
  consumer.activate();
  producer.activate();
  const report = await universe.evolve({ rounds: 2, maxLinkTurnsPerRound: 2 });
  console.log(JSON.stringify({ report, projection: universe.projection(), snapshot: universe.snapshot() }, null, 2));
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
