# Autonomous Encrypted Mesh

This layer closes the gap between the local living graph and a continuously operating distributed agent system.

## Components

### MeshIdentity

Each node owns two independent key pairs:

- Ed25519 for signatures;
- X25519 for key agreement.

Private keys remain local. Public identities contain both public keys and their SHA-256 fingerprints.

### EncryptedTcpTransport

Every outgoing message uses a fresh ephemeral X25519 key. The sender derives a shared secret with the recipient's static encryption key, derives a 256-bit session key with HKDF, and encrypts the canonical JSON payload with AES-256-GCM.

The sender signs the encrypted envelope with Ed25519. The recipient verifies identity pinning, signature, recipient, timestamp and nonce before decryption. Replayed, stale, forged, misaddressed and modified envelopes are dropped.

### DistributedDiscoveryMesh

Each machine publishes its agents' capability boundaries to known peers. Remote advertisements expire automatically.

Agents on different machines can:

1. find complementary capabilities;
2. score mutual usefulness;
3. negotiate relationship terms;
4. create mirrored remote relationships;
5. alternate boundary synchronization over encrypted transport.

Only exposed state is synchronized. Private state never enters the relationship payload.

### NetworkByzantineNode

The leader broadcasts a signed proposal. Every reachable replica independently validates it and returns its own signed vote. The leader forms a certificate only after `2f + 1` distinct valid accept votes and broadcasts the certificate.

One unavailable replica in a four-member committee does not prevent commit. View-change messages are also signed and require quorum.

### PersistentResourceEconomy

The complete market state is atomically persisted after every mutation. Open orders, escrow, trades, balances and journal entries survive process restart.

Offer placement moves the seller's resource into escrow immediately. Bid placement moves the buyer's maximum payment into escrow immediately. Matching cannot reuse either reservation.

### MeteredCognitiveLoop

A thought is an economic operation:

```text
reserve tokens and credits
        ↓
perform provider-neutral LLM completion
        ↓
settle actual usage
        ↓
refund unused reserve
        ↓
validate and apply cognitive decision
```

A cognitive result may update four state layers and request explicit actions. Requested actions are delivered to a caller-supplied action handler; the model cannot claim an external action was completed merely by writing text.

### ContinuousMetaAgentController

Strong clusters must remain stable for several observations before folding. Weak external cohesion must remain weak for several observations before unfolding. This prevents rapid oscillation.

Fold and unfold hooks can be connected to `NetworkByzantineNode`, making automatic architectural reorganization a quorum-approved distributed state transition rather than a unilateral local mutation.

## AutonomousMeshNode

`AutonomousMeshNode` composes transport, discovery, consensus, economy, cognition and fractal organization in one lifecycle:

- start encrypted network listener;
- announce local agents;
- discover and negotiate remote relationships;
- run scheduled minds;
- settle LLM usage;
- collect network votes;
- continuously review clusters;
- checkpoint the economy on shutdown.

It is a composition root, not a central manager. Peer choice remains local, relationship admission remains bilateral, committee decisions require quorum, and independent links continue to evolve concurrently.
