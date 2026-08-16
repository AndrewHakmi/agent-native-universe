# Architecture

Agent Native Universe begins with two computational primitives rather than services, roles, workflows or a central orchestrator.

## NanoAgent

A `NanoAgent` is a bounded local world containing identity, objectives, capabilities, needs, beliefs, four classes of state, commitments, permissions, budgets, invariants, lineage, links and lifecycle.

It exposes only an explicit boundary. Discovery, peer scoring, offer evaluation, boundary projection and protocol suggestions are local decisions. An agent never needs unrestricted access to another agent's context or memory.

Agents can clone, split, merge, sleep, quarantine and retire.

## LinkProtocol

A `LinkProtocol` is not a message queue. It is a durable relationship-state machine between two agents. It owns:

- shared boundary state;
- field ownership;
- alternating mutation rights;
- atomic revisions and evidence;
- negotiated protocol terms;
- activation and synchronization metrics;
- strength and decay;
- probation, active, dormant and retired states.

The default consistency law is:

```text
local sequentiality + global parallelism
```

Only one side can commit the next revision of a strict-alternation link, while unrelated links can evolve concurrently.

## TopologyRuntime

See also [Living graph runtime](LIVING_GRAPH.md) for the complete evolution cycle.

`TopologyRuntime` is an in-process coordination substrate, not a global decision-maker.

It performs operations the environment must provide:

- distribute expiring advertisements;
- advance pairwise negotiation sessions;
- execute independent links concurrently;
- apply deterministic lifecycle laws;
- record topology events;
- contain local failures.

It does not assign global roles, construct a master plan or choose the final graph. Each NanoAgent scores candidates locally. Both participants must accept a relationship. Protocol adaptation belongs to the current link turn owner and its counterparty.

## DiscoveryMesh

`DiscoveryMesh` is a transport surface for limited capability advertisements. It does not select peers or create links. Every active NanoAgent receives a local view and evaluates it according to its own network policy and behavior.

## NegotiationSession

A negotiation is an alternating state machine:

```text
proposal -> accept
         -> counter -> counter -> accept
         -> reject
         -> defer
         -> expire
```

The transcript is durable. Formation and renegotiation use the same primitive.

## Universe

`Universe` currently owns in-memory graph storage and hard referential integrity. It exposes `evolve()` as a convenient entry point into `TopologyRuntime`.

This storage layer can later be replaced by a distributed substrate without changing the semantic contract of NanoAgent and LinkProtocol.

## Constitutional runtime

Hard constraints belong outside model reasoning. `Constitution` provides a deterministic authorization hook for actions that must never depend only on prompt compliance.

## Emergent architecture

Architecture is a projection of the current graph:

```text
Architecture(t) = Projection(NanoAgents(t), LinkProtocols(t))
```

`detectClusters()` provides a first projection: modules emerge from sufficiently strong relationships rather than predefined service boundaries.

Future layers should preserve the rule that orchestration, service boundaries, teams, workflows and hierarchy are derivable structures rather than compulsory foundations.
