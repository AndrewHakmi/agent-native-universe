# Running NanoAgent graph replicas on multiple machines

Each process uses a persistent Ed25519 identity, an independent graph store and a real TCP listener.

## 1. Create identities

Use `IdentityFileStore` once for each replica, then collect every replica's `publicIdentity()` output into the same static committee configuration. Private PEM data stays only on its machine and should be protected by an HSM/KMS or an encrypted secret volume in production.

A Byzantine committee that tolerates one faulty or malicious machine requires four members. In general:

- committee size: `n >= 3f + 1`;
- commit certificate: at least `2f + 1` unique valid votes.

## 2. Node configuration

```json
{
  "id": "replica-0",
  "identityFile": "/var/lib/anu/identity.json",
  "storageDirectory": "/var/lib/anu/graph",
  "listen": { "host": "0.0.0.0", "port": 7400 },
  "committee": [
    {
      "id": "replica-0",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
      "fingerprint": "...",
      "algorithm": "Ed25519"
    }
  ],
  "peers": [
    {
      "id": "replica-1",
      "address": { "host": "10.0.0.12", "port": 7400 },
      "identity": {
        "id": "replica-1",
        "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
        "fingerprint": "...",
        "algorithm": "Ed25519"
      }
    }
  ],
  "checkpointEvery": 25
}
```

Every machine receives the complete committee list and its own peer routing table.

## 3. Start a process

```bash
npm ci
npm run build
node dist/v1/node-runner.js ./replica-0.json
```

The process prints its node ID, key fingerprint and bound address. `SIGINT` and `SIGTERM` create a final checkpoint before shutdown.

## 4. Commit path

A leader creates a proposal for the next sequence. Committee replicas sign votes. Once `2f + 1` unique signatures are assembled, the resulting certificate can be submitted to `DistributedGraphNode.commit()`.

The leader then broadcasts the complete certificate. A receiving machine independently verifies:

- signed transport envelope;
- sender identity and replay nonce;
- committee membership;
- proposal signature and digest;
- unique vote signatures;
- quorum;
- view and sequence;
- deterministic state transition.

Only then is the command fsynced and exposed.

## 5. Recovery

After a crash, the process loads the latest atomic snapshot, verifies its WAL anchor, verifies every subsequent record in the hash chain and deterministically replays the remaining commands. Corrupted records, sequence gaps and mismatched snapshot anchors stop recovery instead of silently accepting divergent state.

## 6. Production boundary

Expose TCP listeners only inside an authenticated private network or service mesh. Add firewalling, connection quotas, certificate rotation, DDoS controls, observability and independent protocol review before Internet exposure.
