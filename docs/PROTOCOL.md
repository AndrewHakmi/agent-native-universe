# LinkProtocol Semantics

## Relationship state

Every link is a first-class stateful object. Participants interact through a negotiated boundary rather than reading each other's private state.

## Atomic revisions

Each successful mutation creates a monotonic revision containing author, parent, timestamp, delta, evidence and mutation kind. Relationship evolution is therefore auditable and replayable.

## Alternating mutation

`strict_alternation` is the default mode. If the left participant commits revision `r`, the right participant owns the next turn.

This provides local serialization without serializing the rest of the graph:

```text
sequentiality(link A-B) + sequentiality(link C-D) + ...
                         =
             global concurrent evolution
```

## Field ownership

Shared fields may be owned by:

- `left`;
- `right`;
- `either`;
- `shared_consensus`;
- `runtime`.

A participant cannot mutate fields outside its ownership. Consensus fields reject unilateral mutation. Runtime-owned fields cannot be modified by either participant.

## Pairwise formation

A relationship is formed only after:

1. capability advertisement;
2. local candidate scoring;
3. protocol proposal;
4. alternating accept/counter/reject/defer decisions;
5. agreement on supported terms;
6. probationary synchronization.

A link is not admitted merely because one agent requested it.

## Pairwise protocol evolution

A protocol review is initiated by the current turn owner. The proposed terms are evaluated by the counterparty through the same alternating negotiation primitive. Accepted terms become one protocol revision authored by the current turn owner, and mutation rights pass to the other participant.

Thus protocol evolution follows the same law as shared-state evolution: neither participant controls the relationship unilaterally.

## Strength

A relationship has dynamic strength in `[0,1]`. Useful interactions reinforce it through:

- activation frequency;
- useful updates;
- information gain;
- utility;
- reliability;
- successful synchronization.

Communication cost, failures, empty turns and elapsed time weaken it.

This lets topology evolve as a consequence of actual work rather than static architecture.

## Lifecycle

```text
candidate -> negotiating -> probation -> active
                                      -> strengthening
                                      -> weakening
                                      -> dormant -> retired
```

Probation requires useful interactions and minimum strength. Dormant links stop participating in normal synchronization and eventually detach.

## Contradictions

Contradictions are represented as relationship state, not silently overwritten. A conflicted link can preserve multiple propositions until evidence or an arbitration mechanism resolves them.


## Runtime integration

Formation, synchronization, protocol adaptation and lifecycle review are composed by the [Living graph runtime](LIVING_GRAPH.md). The runtime preserves link-local ordering while advancing independent relationships concurrently.
