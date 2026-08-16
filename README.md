# Agent Native Universe

**A computational substrate for software and multi-agent systems where architecture emerges from a graph of minimal autonomous worlds connected by stateful adaptive protocols.**

The project is an executable exploration of two primitives:

- **NanoAgent** — a minimal autonomous local universe.
- **LinkProtocol** — a stateful, auditable, adaptive relationship between nanoagents.

The goal is not another agent orchestration framework. The goal is to remove the assumption that complex software must be organized around human-readable files, fixed services, central planners, predefined teams and linear workflows.

## Core law

> Local sequential consistency. Global parallel evolution.

Within one `LinkProtocol`, mutations can be strictly alternating and revisioned. Across a huge graph, independent links can evolve simultaneously.

## Why

Traditional software architecture was optimized for human teams: code ownership, repositories, tickets, PRs, services, meetings and sequential coordination. When intellectual execution becomes cheap and massively parallel, the limiting factor moves from writing code to **safe coordination of concurrent intelligence**.

Agent Native Universe treats the graph itself as the running architecture.

## Implemented in v0.1

NanoAgent identity/lineage/lifecycle; objectives and anti-goals; capabilities and permissions; private/exposed/durable/ephemeral state; beliefs; commitments and budgets; runtime invariants; clone/split/merge; LinkProtocol shared state; field ownership; strict alternating mutation; atomic revisions with evidence; protocol mutation; contradiction preservation; link metrics, strength and decay; graph integrity and emergent clusters; constitutional authorization; append-only event store; CLI, example, tests and CI.

## Quick start

```bash
npm run build
npm test
npm run demo
```

A participant cannot commit twice in succession on a strict-alternation link, and cannot modify fields owned by the counterparty. These are runtime laws, not prompt instructions.

## Design constraints

This repository intentionally does not make manager agents, a central planner, global task queue, global mutable memory, predefined microservices, human job roles or fixed workflows foundational primitives. If useful, those structures should emerge as compositions of NanoAgents and LinkProtocols.

## Direction

Next hard problems: distributed persistence, negotiated consensus fields, protocol discovery/handshake, autonomous link formation, gossip with provenance, leases, ephemeral arbitration agents, cluster compression, recursive/fractal agents, parallel scheduling and model/tool adapters.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [PROTOCOL.md](docs/PROTOCOL.md).
