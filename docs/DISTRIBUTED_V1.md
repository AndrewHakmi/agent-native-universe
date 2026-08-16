# Distributed Agent-Native Runtime v1

This layer turns the in-process living topology into a distributed, durable and economically bounded runtime.

## One integrated execution law

A remote graph mutation is accepted only when all of the following are true:

1. it arrives through a real length-framed TCP connection;
2. the envelope is signed by a registered Ed25519 identity;
3. its timestamp and nonce pass replay protection;
4. the mutation carries a valid static-committee Byzantine quorum certificate;
5. the sequence is the next committed replicated sequence;
6. it is durably appended to the hash-chained WAL before becoming visible;
7. the deterministic graph reducer accepts the transition;
8. resource balances remain non-negative;
9. a snapshot can later anchor recovery to the same WAL chain.

This is intentionally stronger than sending prompts between several agents. Hard safety properties live below model reasoning.

## Distributed network and transport

`TcpTransport` implements a real network boundary using Node's TCP stack and four-byte length framing. `SecureTransport` signs structured envelopes and verifies identity, recipient, clock skew and replay nonce before dispatch.

A `DistributedGraphNode` can bind to any host/port and maintain peer addresses on other machines. Replicated certificates are broadcast to peers; one failed or unreachable peer does not prevent delivery attempts to the others.

## Persistent graph and recovery

`PersistentGraphStore` combines:

- an append-only JSONL WAL;
- monotonic sequence numbers;
- a SHA-256 previous-hash chain;
- fsync before acknowledgement;
- atomically renamed snapshots;
- checksum validation;
- replay only after the snapshot anchor;
- corruption and sequence-gap rejection.

Recovery is deterministic: `snapshot + verified WAL tail -> current graph`.

## Cryptographic identity

Every node has an Ed25519 keypair. Public identities contain a stable ID, PEM public key and SHA-256 fingerprint. Substitution of a different key under an existing ID is rejected. Signed envelopes preserve sender, recipient, topic, timestamp, nonce, payload and signature.

Production key custody should use an HSM, KMS or encrypted secret store. Private keys must never be committed to the repository.

## Byzantine fault tolerance

`ByzantineQuorum` uses a static committee of `n >= 3f + 1` replicas and requires `2f + 1` unique valid accept votes for a commit certificate. It verifies:

- deterministic leader by view;
- proposal digest and proposer signature;
- voter membership and signature;
- sequence/view/digest agreement;
- unique voters;
- quorum size;
- quorum-signed view changes.

The implementation is a PBFT-style safety core under authenticated channels and partial-synchrony assumptions. It is not claimed to be formally verified.

## LLM providers

Agents depend on the provider-neutral `LlmProvider` contract. Included adapters cover:

- OpenAI-compatible chat completion endpoints;
- Anthropic Messages;
- local Ollama chat.

`LlmRouter` selects healthy providers by required capabilities, preference and estimated cost, then fails over without changing agent code. API keys are supplied at runtime only.

## Resource economy

`ResourceLedger` is a non-negative double-entry ledger for:

- credits;
- compute milliseconds;
- model tokens;
- storage bytes;
- bandwidth bytes.

`ResourceMarket` supports offers, bids, matching, credit escrow, resource delivery, settlement and refund. Agents therefore cannot treat compute, tokens and external effects as unlimited ambient resources.

Replicated resource commands can be committed through the same BFT graph log.

## Fractal metaagents

`FractalUniverse` detects strongly connected components and can fold a cluster into a `MetaAgentRecord` that:

- aggregates capabilities;
- stores the internal agents and links;
- rewrites only boundary links;
- preserves provenance and cluster digest;
- can be unfolded reversibly;
- can itself be folded into a higher-order metaagent.

The same `agent <-> protocol <-> agent` abstraction can therefore operate at nanoagent, cluster, service and system scales.

## Verification

`test/distributed-v1.test.mjs` adds sixteen integration tests. Together with the existing twenty-three tests, the repository exercises thirty-nine behaviors, including real sockets, signature tampering, replay, WAL corruption, snapshot recovery, BFT quorum/view change, market escrow, provider fallback, recursive folding and replication followed by process restart.

## Explicit limits

This repository is a research/reference-grade runtime. Before hostile Internet production use it still needs independent security review, fuzzing, property-based and chaos tests, formal protocol analysis, dynamic committee reconfiguration, key rotation/revocation infrastructure, WAN benchmarks, DDoS controls and a production-grade membership/discovery plane.
