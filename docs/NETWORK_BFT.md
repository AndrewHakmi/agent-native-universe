# Networked Byzantine Consensus

`NetworkBftGraphNode` extends the static-committee safety core into an authenticated multi-node protocol. Every replica keeps its own Ed25519 private key; no coordinator receives or impersonates another member's key.

## Message flow

```text
leader
  └─ signed bft.proposal ─────────────► replicas
                                      │
replicas                              │ validate proposal, sequence and state transition
  └─ signed bft.vote ─────────────────► leader
                                      │
leader                                │ collect 2f+1 unique accept votes
  └─ signed bft.commit certificate ──► replicas
                                      │
replicas                              │ verify every signature, fsync WAL, apply reducer
                                      ▼
                              replicated graph state
```

All messages travel through `SecureTransport` over real length-framed TCP connections. The transport verifies sender key pinning, recipient, timestamp, signature and replay nonce before consensus code receives a message.

## Fault model

For committee size `n`, the implementation uses:

```text
f = floor((n - 1) / 3)
quorum = 2f + 1
```

Four replicas therefore tolerate one unavailable or Byzantine replica for commit safety and quorum progress, assuming the other three can communicate.

The leader cannot fabricate quorum because every vote is independently signed on the voter's machine. Duplicate voters, non-members, altered commands, wrong sequence/view and signature substitution are rejected.

## Certified catch-up

Each accepted commit certificate is fsynced to `certificates.jsonl` in addition to the graph WAL. A replica that was unavailable can request all certificates after its current sequence:

```text
bft.sync.request { fromSequence }
        ↓
bft.sync.response { certificates[] }
```

The recovering replica independently verifies and applies every certificate in sequence. It does not trust a raw remote snapshot.

## View change

Replicas can emit signed `bft.view-change` messages. A new deterministic leader becomes active only after a quorum of unique valid view-change signatures targets the same higher view.

## Verified scenarios

The integration suite starts four independent node instances with separate identities, TCP listeners and persistent stores. It verifies:

1. proposal and votes cross real sockets and form a three-signature certificate;
2. all four graphs converge on the same command;
3. the committee continues committing with one replica offline;
4. the returning replica catches up from certified history;
5. view change occurs only after quorum.

## Boundary

This is a PBFT-style authenticated static-committee implementation, not a formally verified complete consensus product. Production evolution still requires dynamic membership/reconfiguration, checkpoint certificates and log compaction, automatic timeout pacemakers, equivocation evidence and slashing policy, WAN/partition testing, formal model checking and independent security review.
