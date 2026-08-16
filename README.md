# Agent Native Universe

**An agent-native runtime where architecture emerges from autonomous NanoAgents and the stateful protocols they negotiate with one another.**

Agent Native Universe explores two computational primitives:

- **NanoAgent** — a bounded local world with its own objective, state, capabilities, needs, policy, memory, budget and behavior.
- **LinkProtocol** — a durable, adaptive relationship-state machine jointly controlled by two NanoAgents.

The project is not a manager-agent framework and not a conventional workflow engine. Its purpose is to remove the assumption that complex software must be organized around fixed services, central planners, human job roles and linear task pipelines.

## Core law

> **Local sequential consistency. Global parallel evolution.**

One `LinkProtocol` advances through ordered, revisioned turns. Independent links across the graph advance concurrently.

```text
NanoAgent <== stateful adaptive protocol ==> NanoAgent
    |                                          |
    +====== protocol ====== NanoAgent =========+
```

The graph is not a diagram of the system. **The live graph is the system.**

## Living topology

NanoAgents no longer need a caller to wire them together with `Universe.connect()`:

```text
publish capability boundary
          ↓
discover locally useful peers
          ↓
score compatibility from local needs
          ↓
propose complete protocol terms
          ↓
accept / counter / reject / defer
          ↓
probationary LinkProtocol
          ↓
alternating boundary synchronization
          ↓
strengthen / adapt / weaken / retire
```

Each node decides locally whom it considers useful. Each relationship is admitted bilaterally. The runtime supplies transport, causal ordering, pair isolation, logical time, hard invariants and failure containment—but it does not own a global product goal or secretly choose the architecture.

## Implemented in v0.2

### NanoAgent

- stable identity, generation and lineage;
- objectives, anti-goals and weighted preferences;
- capabilities and explicit connection needs;
- active, passive or disabled discovery policy;
- private / exposed / durable / ephemeral state;
- beliefs with confidence and uncertainty state;
- commitments, permissions and resource budgets;
- local candidate scoring and behavior hooks;
- local offer acceptance, counteroffer, rejection or deferral;
- boundary projection without exposing private state;
- protocol adaptation proposals;
- clone / split / merge / sleep / quarantine / retire;
- deterministic runtime invariants.

### LinkProtocol

- negotiated shared boundary state;
- field-level ownership;
- strict alternating mutation rights;
- atomic revisions with author, parent, evidence and mutation kind;
- explicit empty-turn transfer instead of fabricated data;
- payload modes: full state, structured, delta and event-only;
- activation modes and communication budgets;
- probation and evidence-based promotion;
- information gain, utility, reliability, synchronization and cost metrics;
- adaptive strength, decay and lifecycle;
- bilateral protocol renegotiation;
- contradiction preservation and consensus mutation support.

### Living graph runtime

- expiring decentralized capability advertisements;
- autonomous peer discovery;
- compatibility scoring from capabilities, needs, reciprocity and cost;
- alternating formation and renegotiation handshakes;
- rejection cooldowns and link-capacity limits;
- concurrent advancement of independent links;
- local failure containment;
- automatic promotion, weakening, dormancy, heartbeat reactivation and retirement;
- append-only topology events and negotiation transcripts;
- emergent cluster detection;
- constitutional authorization below model reasoning.

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm test
npm run demo:living
```

The repository currently has zero runtime npm dependencies.

## Autonomous example

```ts
import { Universe } from "agent-native-universe";

const objective = (primary: string) => ({
  primary,
  secondary: [],
  antiGoals: ["unsafe_write"],
  weights: { utility: 1, risk: -1 }
});

const universe = new Universe();

const producer = universe.createAgent({
  objective: objective("produce market signal"),
  capabilities: [{
    id: "market.sensor",
    accepts: ["quality.feedback"],
    produces: ["market.signal"],
    riskClass: "low"
  }],
  exposedState: { signal: { velocity: 0.81 } }
});

const consumer = universe.createAgent({
  objective: objective("detect opportunity"),
  capabilities: [{
    id: "opportunity.detector",
    accepts: ["market.signal"],
    produces: ["market.opportunity"],
    riskClass: "low"
  }],
  needs: [{
    id: "signal-input",
    accepts: ["market.signal"],
    priority: 1,
    recurring: true,
    maxCommunicationCost: 8,
    minReliability: 0.5
  }]
});

producer.activate();
consumer.activate();

const report = await universe.evolve({
  rounds: 3,
  maxLinkTurnsPerRound: 2
});

console.log(report.linksCreated);
console.log(universe.projection());
```

No explicit connection is created. The agents advertise, discover, negotiate, enter probation, synchronize their boundaries and either prove the relationship useful or lose it.

## Runtime laws, not prompt requests

A participant cannot:

- commit twice in succession on a strict-alternation link;
- modify a field owned by the counterparty;
- unilaterally modify a consensus field;
- exceed the negotiated communication budget;
- mutate a retired or quarantined relationship;
- silently rewrite relationship history.

These rules are enforced by deterministic TypeScript runtime code below any LLM or behavior adapter.

## Commands

```bash
npm run demo          # deterministic manually connected example
npm run demo:living   # autonomous topology evolution
npm test              # compile and execute all tests

node dist/cli/index.js principles
node dist/cli/index.js living
```

## Design constraints

The following are intentionally **not** foundational primitives:

- manager agents;
- a central planner;
- a global task queue;
- globally mutable agent memory;
- predefined microservices;
- human job roles;
- fixed workflows.

They may still emerge as useful graph configurations. They are not imposed as universal laws.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [LinkProtocol semantics](docs/PROTOCOL.md)
- [Living graph runtime](docs/LIVING_GRAPH.md)

## Next hard problems

Distributed persistence, cryptographically verifiable provenance, leases and partitions, gossip, autonomous agent birth/death, resource markets, negotiated consensus fields, ephemeral arbitration agents, cluster compression, recursive/fractal agents, distributed scheduling and real model/tool adapters.

## Status

This is experimental infrastructure and a research-grade executable substrate, not yet a production security boundary. The current in-memory runtime makes the primitives testable before distributing them across processes and machines.
