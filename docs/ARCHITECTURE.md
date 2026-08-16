# Architecture

Agent Native Universe intentionally starts from two computational primitives rather than from services, roles, workflows, or a central orchestrator.

## NanoAgent

A `NanoAgent` is a bounded local world: identity, objectives, capabilities, beliefs, four classes of state, commitments, permissions, budgets, invariants, lineage, links, and lifecycle. Agents can clone, split, merge, sleep, quarantine, and retire.

## LinkProtocol

A `LinkProtocol` is not a message queue. It is a durable relationship-state machine between two agents. It owns shared state, field ownership, alternating mutation rights, atomic revisions, evidence, link metrics, strength, decay, lifecycle and protocol evolution.

The default consistency law is:

`local sequentiality + global parallelism`.

Only one side can commit the next revision of one link under strict alternation, while independent links across the universe can evolve concurrently.

## Universe

`Universe` is currently an in-process graph container, not a permanent global coordinator. It provides discovery and graph operations while preserving the design constraint that coordination semantics live in agents and links. It can eventually be replaced by a distributed substrate without changing the core primitives.

## Constitutional runtime

Hard constraints belong outside LLM reasoning. The `Constitution` primitive gives the runtime a deterministic authorization hook for actions that must never depend only on prompt compliance.

## Emergent architecture

Modules are projections of graph structure. `detectClusters()` demonstrates the first form of this: clusters emerge from sufficiently strong relationships rather than from predefined service boundaries.

Future layers should preserve the rule that orchestration, service boundaries, teams, workflows and hierarchy are derivable structures rather than compulsory foundations.
