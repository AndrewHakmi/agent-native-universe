# Universe Lab deployment

This deployment runs the first logical Universe Lab stand as two roles built
from the same Node.js 22 image:

- `lab-observer` continuously serves evidence and `GET /healthz` on container
  port 3000 on the internal control network;
- `lab-observer-edge` is an explicit `edge` profile with application Bearer
  authentication plus the Traefik route;
- `lab-runner` is an explicit, one-shot `runner` profile that writes experiment
  evidence and exits.

The deployment deliberately does not give the lab access to the Docker API.
Neither service mounts `docker.sock`, publishes a host port, runs privileged, or
receives Linux capabilities.

The current manifest-bound logical engine identity is
`genesis-logical-v1.1.0`.

## Runtime contract

The image expects the TypeScript build to produce `dist/lab/runner.js` with
these commands:

```text
node dist/lab/runner.js serve --data-dir /data --port 3000
node dist/lab/runner.js serve --data-dir /data --port 3000 \
  --auth-token-file /run/secrets/anu_lab_observer_token
node dist/lab/runner.js run --data-dir /data --universes N --agents N --ticks N
node dist/lab/runner.js attest --data-dir /data --universe-id U0001 --run-id RUN_ID
node dist/lab/runner.js verify-attestation --data-dir /data \
  --universe-id U0001 --run-id RUN_ID --expected sha256:HASH
```

The server must bind to `0.0.0.0:3000` inside the container. `/healthz` reports
process liveness; the container healthcheck uses `/readyz` so an inaccessible
evidence directory prevents a false healthy state. Both probe routes remain
unauthenticated inside the application. When `--auth-token-file` is present,
all evidence routes require one exact `Authorization: Bearer <token>` header.

The logical runner handles SIGINT and SIGTERM at durable tick boundaries. The
active tick completes, deterministic runtime state and world state are flushed
to an immutable checkpoint, child workers release their writer leases, and the
CLI reports `paused`. Re-running the identical command automatically resumes
only after semantic replay matches that checkpoint and the event-chain tail.
Mid-tick crash evidence is never truncated or silently repaired and therefore
still requires diagnosis. The long-running observer handles `SIGTERM`
gracefully as before.

## Infrastructure prerequisites

The Compose file reuses the server's existing Traefik installation. Before
deployment, verify without printing any credentials:

```bash
docker version
docker compose version
docker network inspect dev-studyninja-network >/dev/null
docker inspect dev-traefik --format '{{.State.Status}}'
```

The following Traefik resources must already exist:

- external Docker network `dev-studyninja-network`;
- HTTPS entrypoint `websecure`;
- ACME resolver `letsencrypt` using HTTP-01;
- a dedicated rotated ForwardAuth/SSO middleware that does not consume or
  replace the application's `Authorization: Bearer` header;
- an external token file readable as container UID 1000.

Only the opt-in `lab-observer-edge` joins the shared edge network. The default
observer and experiment runner join only the Compose-owned `control` network,
which is declared `internal: true`. All roles use the named `lab-evidence`
volume; observers mount it read-only.
Compose also applies explicit CPU and memory ceilings; tune
`ANU_LAB_CPUS`/`ANU_LAB_MEMORY_LIMIT` only after measuring the shared host.

## Configuration and validation

The checked-in `.env.example` contains safe, conservative defaults for the
current host: one logical universe, 16 agents, and 500 ticks. Use it directly
for validation and the first run:

```bash
docker compose --env-file .env.example -f compose.lab.yml config
docker compose --env-file .env.example -f compose.lab.yml build lab-observer
```

The checked-in token path is `/dev/null`, so the edge observer cannot start
with the example defaults. Before enabling `edge`, generate a token outside the
repository without printing it and make the source readable by container UID
1000 (file-secret ownership overrides are not implemented by every Compose
version):

```bash
install -d -m 0700 /root/.secrets/anu-lab
umask 077
openssl rand -base64 48 | tr -d '\n' > /root/.secrets/anu-lab/observer-token
chown 1000:1000 /root/.secrets/anu-lab/observer-token
chmod 0400 /root/.secrets/anu-lab/observer-token
export ANU_LAB_OBSERVER_TOKEN_FILE=/root/.secrets/anu-lab/observer-token
```

The Observer reads the mounted token once during startup, removes only one
conventional final LF or CRLF, requires at least 32 token68 bytes, and never
includes token contents in structured logs or error responses. Rotating it
therefore requires replacing the external file and recreating the edge
container. Do not put the token itself in `.env`, Compose labels, or command
arguments.

To override a value without creating a repository-local secret file, export it
in the shell or provide an env file stored outside the repository:

```bash
export ANU_LAB_TICKS=10000
export ANU_LAB_AGENTS=64
docker compose -f compose.lab.yml --profile runner run --rm lab-runner
```

Large runs are intentionally opt-in. The current server should be benchmarked
before increasing concurrency or running many physical node containers. The
checked-in Compose command retains CLI parallelism 1. Production population
workers are separate Node.js processes, so `--parallel` now controls real
multi-core concurrency and multiplies per-universe memory pressure. With the 2
GB memory limit, `--parallel 2` is a conservative next starting estimate for an
explicit population run, pending a live benchmark. The complete target of 32 universes
with 64 agents × 10,000 ticks has not yet been completed under this limit and
must not be treated as validated production capacity.

The standard Genesis path records events without retaining a second complete
in-memory event array, then performs streaming replay that verifies the entire
hash chain. Checkpoints still contain a complete projected world state, so short
checkpoint intervals can cause substantial disk amplification.
Reads of a single checkpoint are capped at 64 MiB to fail closed on corrupted
or unexpectedly amplified artifacts; inspect checkpoint size before increasing
agent/task scale beyond the reference configuration.

Every normally completed run stores `attestations/final.json`. Copy its
`commitment` to an independently controlled append-only or signed store; keeping
the commitment only on the same Docker volume does not protect against a full
volume rewrite. Verification always performs full semantic replay and compares
the reconstructed summary and metrics before accepting `--expected`. All five
trusted evidence inputs stay open through one fd-anchored snapshot. Pathname
replacement cannot redirect reads after the files are opened, while metadata
changes to those open artifacts during the pass fail closed.

The target-shaped ObservationFrame microbenchmark and current storage envelope
are documented in `docs/LAB_CAPACITY.md`. The optimization removes repeated
historical task scans from each agent observation, but it does not change the
capacity statement above: the full `32 × 64 × 10,000` population is not yet
validated.

New evidence is stored at
`<data-dir>/<experiment>/<universe>/<run-id>/`. Replaying a universe with more
than one compatible run requires `anu lab replay ... --run-id '<RUN_ID>'`; the
CLI refuses an ambiguous implicit selection. The v1.1 projector also rejects
manifests from other engine identities instead of silently applying changed
semantics to historical evidence. Replay reads the run's immutable
`config.json`, re-derives its manifest and deterministic protocol, and validates
the complete log, terminal completion event, and manifest-bound neutral-policy
decision stream even when the requested projection uses `--until-tick`.

Secure evidence traversal requires Linux `/proc/self/fd`. Every directory
component and final artifact operation is anchored to held descriptors with
`O_NOFOLLOW`, closing parent rename-plus-symlink redirection during concurrent
local access. The supplied container image satisfies this runtime requirement.

## Start and observe

Start the internal-only long-running observer:

```bash
docker compose --env-file .env.example -f compose.lab.yml up -d --build lab-observer
docker compose --env-file .env.example -f compose.lab.yml ps
docker compose --env-file .env.example -f compose.lab.yml logs -f lab-observer
```

Run one logical experiment in a disposable container:

```bash
docker compose --env-file .env.example -f compose.lab.yml --profile runner run --rm lab-runner
```

After configuring both the external token file and the independent Traefik
middleware, start the public variant explicitly (do not run both observer
variants unless two readers are intentional):

```bash
docker compose --env-file .env.example -f compose.lab.yml --profile edge \
  up -d --build lab-observer-edge
```

Verify the public route after the edge observer becomes healthy:

```bash
curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}\n' https://lab.anu.xteam.pro/healthz
```

The Traefik middleware may return `401 Unauthorized` even for a public probe;
that confirms the outer route is protected. The container healthcheck reaches
`/readyz` directly and does not need the application token. An unauthenticated
request that reaches an evidence route on the application also returns a
generic JSON `401` and `WWW-Authenticate: Bearer` without exposing evidence.
Use the Traefik dashboard or container health state to distinguish an outer
authentication response from an unhealthy backend.

Before enabling the Traefik router, set `ANU_LAB_AUTH_MIDDLEWARE` to a rotated
ForwardAuth/SSO middleware. The checked-in value deliberately names a
nonexistent fail-closed placeholder. A BasicAuth middleware is not suitable for
this route because it competes for the same `Authorization` header that the
application requires for its Bearer token. Keep the observer off the edge
network until both independent authentication layers are configured.

Traefik authentication protects only requests that pass through Traefik. Once
the edge profile joins the shared `dev-studyninja-network`, another container on
that network can reach port 3000 directly and bypass the router middleware. The
edge Observer now closes that bypass with its own Bearer check on every evidence
route. `/healthz` and `/readyz` intentionally reveal only probe state and remain
unauthenticated at the application layer. The Observer UI remains pending; the
authenticated read-only API is the supported public surface.

## Observer pagination

The public event endpoint remains:

```text
GET /api/runs/:runId/events?after=<sequence>&limit=<count>
```

The Observer learns a bounded sparse cursor index in memory. This allows high
sequence cursors in event logs larger than 64 MiB to seek near the requested
page while preserving the per-request scan bound. The index is not persisted,
is rebuilt lazily after process restart, and does not replace the hash-chained
event log as evidence. Warm-index performance therefore must not be assumed for
the first request after restart.

The HTTP page reader validates bounded JSON records, a final newline, and local
sequence continuity around the selected page; it does not re-hash the complete
prefix on every request. Run `anu lab replay` for authoritative full-chain and
projection verification.

Run detail responses include the optional final attestation alongside manifest
and summary. `attestationStatus` is `missing`, `invalid`, or `self_consistent`;
the last value validates only the canonical envelope and its self-commitment.
The Observer does not independently replay it; use `anu lab verify-attestation`
with an externally stored expected commitment as the semantic authority.

Run discovery serves at most 1,000 uniquely addressed runs. If that bounded
scan is incomplete it returns 503; if duplicate run IDs are present it returns
409. Neither catalogue nor detail endpoints select from partial or ambiguous
evidence.

Stop the service without deleting evidence:

```bash
docker compose --env-file .env.example -f compose.lab.yml down
```

Do not add `--volumes` unless permanent deletion of all experiment evidence is
explicitly intended.

## DNS and TLS

Create an A record for `*.anu.xteam.pro` pointing to the server. A wildcard DNS
record only controls name resolution; it does not create a wildcard TLS
certificate. The router in `compose.lab.yml` requests a normal per-host
certificate for `lab.anu.xteam.pro` through the existing HTTP-01 resolver.

HTTP-01 requires public access to ports 80 and 443. A real
`*.anu.xteam.pro` certificate would require a separately configured DNS-01
resolver and protected DNS credentials. It is not required for this stand.
Also note that `*.anu.xteam.pro` does not cover the apex `anu.xteam.pro`; the
current deployment uses only `lab.anu.xteam.pro`.

## Security boundary

The Compose file applies a read-only root filesystem, a non-root UID, dropped
capabilities, `no-new-privileges`, a bounded PID count, a small writable tmpfs,
rotated container logs, a read-only evidence mount for the observer, HSTS,
bounded edge request rates/concurrency, and defense-in-depth authentication.

Do not add any of the following to a lab service:

- `/var/run/docker.sock`;
- `privileged: true`;
- `network_mode: host`;
- host PID or IPC namespaces;
- direct host bindings for port 3000;
- provider API keys in Compose labels, commands, or repository files.

Future LLM access should pass through a dedicated gateway that alone has an
egress network and file-mounted provider secrets. Universe workers should stay
on internal networks.
