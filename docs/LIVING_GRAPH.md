# Living Topology

A living topology is a graph whose connections are consequences of local work rather than predefined architecture.

## One evolution round

```text
local advertisement
        ↓
local peer scoring
        ↓
pairwise alternating handshake
        ↓
probationary LinkProtocol
        ↓
parallel boundary synchronization
        ↓
strength / reliability update
        ↓
pairwise protocol review
        ↓
strengthen / weaken / sleep / retire
```

Only causal dependencies are sequential. Independent candidate evaluation and independent links can advance concurrently.

## 1. Advertisement

Each eligible NanoAgent publishes a time-limited description of:

- accepted and produced topics;
- capabilities;
- current needs;
- objective projection;
- available link capacity;
- admissible protocol modes;
- communication and reliability limits.

Private state and internal reasoning are not advertised.

## 2. Local discovery

Each NanoAgent scores visible peers independently. Compatibility considers directional capability coverage, reciprocity, objective affinity, need priority, communication cost and available capacity.

A transport can expose candidates, but it cannot force an agent to select them.

## 3. Pairwise handshake

The initiating agent proposes protocol terms. The recipient may accept, counter, reject or defer. Counteroffers reverse proposer/recipient roles, creating an alternating negotiation transcript.

There is no central arbitration for ordinary admission.

## 4. Probation

An accepted relationship starts in `probation`. It must demonstrate enough successful synchronization and reach a negotiated minimum strength before becoming active.

This prevents speculative links from permanently inflating graph density.

## 5. Boundary synchronization

The current link turn owner projects a limited boundary. The counterparty observes that projection in ephemeral local state. Private memory is not copied.

A changed boundary creates an atomic state revision. An unchanged boundary passes the turn without pretending that new information was produced.

Independent links synchronize concurrently; each individual link remains locally serialized.

## 6. Protocol adaptation

After enough revisions, the current turn owner may propose a protocol change. Proposals can alter payload compression, activation mode, heartbeat, information threshold, communication budget, decay or probation parameters.

The counterparty evaluates the change through a new pairwise negotiation. Accepted changes become protocol revisions and pass mutation rights to the other side.

## 7. Topology evolution

Useful links strengthen. Expensive, unreliable or inactive links weaken. Weak active links become dormant. A dormant relationship can reactivate when a heartbeat probe discovers new boundary information; otherwise it retires after its idle budget is exhausted.

This means the graph continuously removes relationships that no longer justify their coordination cost.

## 8. Failure containment

A failed projection or protocol decision is recorded against the local agent/link. Other independent links continue to advance. One local world cannot crash the entire topology round.

## Layer scope

The local living-graph layer described here is deterministic and in-process. It
defines the topology semantics without requiring a network. ANU's higher layers
add authenticated remote transport, cryptographic identity, and network
Byzantine agreement; see `docs/AUTONOMOUS_MESH.md`, `docs/MULTI_MACHINE.md`, and
`docs/NETWORK_BFT.md`.
