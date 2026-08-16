# Agent Native Universe

**An agent-native runtime where autonomous NanoAgents discover one another, negotiate stateful relationships, think through interchangeable LLM providers, pay for their own resource use, reach distributed agreement, and recursively organize into MetaAgents.**

The project is built around two primitives:

- **NanoAgent** — a bounded local world with its own objective, state, capabilities, needs, policy, memory, budget and behavior.
- **LinkProtocol** — a durable, adaptive relationship jointly controlled by its participants.

The graph is not merely a diagram of the system. **The live graph is the system.**

> **Local sequential consistency. Global parallel evolution.**

## Runtime layers

### Local living graph

NanoAgents can:

- advertise what they accept, produce and need;
- discover useful peers;
- accept, reject or counter relationship proposals;
- expose only a negotiated boundary rather than private state;
- synchronize LinkProtocols through alternating turns;
- adapt communication frequency and payload shape from observed utility;
- strengthen, weaken, sleep, reactivate and retire relationships;
- clone, split and merge while preserving lineage.

### Autonomous encrypted mesh

The `agent-native-universe/autonomous` entrypoint adds the missing end-to-end connections:

- live capability discovery across different processes and machines;
- bilateral cross-machine relationship negotiation;
- alternating remote boundary synchronization;
- X25519 key agreement and AES-256-GCM payload encryption;
- Ed25519 authentication and tamper detection;
- replay protection and identity pinning;
- real length-framed TCP transport.

Plaintext agent state is not present in network frames.

### Network Byzantine agreement

Committee members keep their own private keys and exchange proposals and votes through the encrypted mesh.

For `n` committee members the runtime tolerates:

```text
f = floor((n - 1) / 3)
quorum = 2f + 1
```

A leader cannot manufacture the other replicas' votes. Each replica independently validates and signs its decision. A commit certificate is applied only after a valid quorum, and view-change votes can move leadership after failure.

### Durable resource economy

The persistent economy tracks:

- credits;
- compute time;
- model tokens;
- storage;
- bandwidth.

Both sides of a market order are reserved immediately:

- seller resources move into offer escrow;
- buyer credits move into bid escrow;
- price improvement is refunded;
- trade resources and payment settle atomically;
- cancellation and expiry return unused escrow;
- balances, orders, trades and the journal survive restart.

This prevents the same resource from being offered twice.

### Metered LLM cognition

`MeteredCognitiveLoop` makes an LLM invocation part of an agent's actual thought cycle.

The runtime:

1. serializes the agent's objective and local state;
2. reserves model tokens and optional credits;
3. routes the request through a provider-neutral completion interface;
4. settles actual usage to the provider account;
5. refunds unused reservation;
6. applies validated private, exposed, durable and ephemeral state changes;
7. dispatches requested actions through an explicit action handler.

The existing OpenAI-compatible, Anthropic and Ollama adapters can be used through the same interface.

### Continuous fractal organization

Stable strongly connected clusters can be folded automatically into MetaAgents. Weak MetaAgent boundaries can be unfolded automatically.

The controller supports:

- stability windows before folding;
- hysteresis before unfolding;
- recursive higher-order MetaAgents;
- deterministic MetaAgent identities;
- optional BFT-gated fold and unfold operations.

A cluster can therefore become one externally visible agent without losing its internal members, links, lineage or reversibility.

## High-level composition

`AutonomousMeshNode` connects the complete runtime:

```text
local NanoAgents
      ↓
encrypted distributed discovery
      ↓
remote relationship negotiation
      ↓
alternating boundary synchronization
      ↓
LLM cognition + automatic resource settlement
      ↓
network BFT for shared decisions
      ↓
persistent economy and graph-side effects
      ↓
continuous fractal MetaAgent formation
```

The same encrypted transport carries discovery, relationship and committee traffic while each subsystem retains independent local failure containment.

## Quick start

Requires Node.js 22 or newer.

```bash
npm ci
npm run build
npm test
npm run demo:living
```

The repository has zero runtime npm dependencies.

## Imports

```ts
import { Universe } from "agent-native-universe";

import {
  DistributedGraphNode,
  PersistentGraphStore,
  ByzantineQuorum,
  ResourceLedger,
  LlmRouter,
  FractalUniverse,
} from "agent-native-universe/distributed";

import {
  AutonomousMeshNode,
  MeshIdentity,
  EncryptedTcpTransport,
  DistributedDiscoveryMesh,
  NetworkByzantineNode,
  PersistentResourceEconomy,
  MeteredCognitiveLoop,
  CognitiveScheduler,
  ContinuousMetaAgentController,
} from "agent-native-universe/autonomous";
```

## Runtime laws, not prompt requests

The deterministic runtime prevents a participant from:

- writing twice in succession on a strict-alternation relationship;
- changing fields owned by another participant;
- silently rewriting relationship history;
- accepting a forged or replayed encrypted message;
- committing a committee decision without enough unique signatures;
- spending a negative balance;
- selling resources that have already been reserved;
- consuming LLM resources without settlement;
- folding unstable clusters immediately.

## Repository map

```text
src/core/       NanoAgent and LinkProtocol primitives
src/runtime/    local living topology
src/v1/         signed distributed graph, persistence, economy and provider adapters
src/v2/         autonomous encrypted mesh and integrated runtime
test/           deterministic, network and recovery tests
docs/           architecture and operating semantics
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [LinkProtocol semantics](docs/PROTOCOL.md)
- [Living graph runtime](docs/LIVING_GRAPH.md)
- [Distributed v1](docs/DISTRIBUTED_V1.md)
- [Multi-machine operation](docs/MULTI_MACHINE.md)
- [Network BFT](docs/NETWORK_BFT.md)
- [Autonomous encrypted mesh](docs/AUTONOMOUS_MESH.md)

## Status

This is a research-grade executable substrate. It now includes real encrypted networking, persistent recovery, distributed voting, durable resource settlement, metered cognition and continuous fractal organization. It is not yet a formally verified or independently audited production security boundary.
