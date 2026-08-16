# LinkProtocol Semantics

## Relationship state

Every link is a first-class stateful object. Participants see a negotiated boundary rather than each other's private state.

## Atomic revisions

Each successful mutation produces a monotonic revision with author, parent, timestamp, delta, evidence and mutation kind. This makes relationship evolution auditable and replayable.

## Alternating mutation

`strict_alternation` is the default mode. If the left participant commits revision `r`, the right participant owns the next turn. This prevents concurrent mutation of the same relationship without serializing the rest of the graph.

## Field ownership

Shared protocol fields can be owned by `left`, `right`, `either`, `shared_consensus`, or `runtime`. A participant cannot mutate fields outside its ownership. Consensus fields are intentionally rejected by unilateral mutation and require a higher-level agreement mechanism.

## Strength

A relationship has a dynamic strength in `[0,1]`. Useful interactions increase strength through activation frequency, useful updates, information gain, utility, reliability and synchronization quality. Communication cost, errors and time decay weaken it.

This lets graph topology evolve as a consequence of work rather than static architecture.

## Contradictions

Contradictions are represented as state, not silently overwritten. A conflicted link can preserve multiple propositions until evidence resolves them.
