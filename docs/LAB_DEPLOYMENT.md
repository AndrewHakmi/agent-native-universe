# Universe Lab deployment

This deployment runs the first logical Universe Lab stand as two roles built
from the same Node.js 22 image:

- `lab-observer` continuously serves evidence and `GET /healthz` on container
  port 3000 on the internal control network;
- `lab-observer-edge` is an explicit `edge` profile with the Traefik route;
- `lab-runner` is an explicit, one-shot `runner` profile that writes experiment
  evidence and exits.

The deployment deliberately does not give the lab access to the Docker API.
Neither service mounts `docker.sock`, publishes a host port, runs privileged, or
receives Linux capabilities.

## Runtime contract

The image expects the TypeScript build to produce `dist/lab/runner.js` with
these commands:

```text
node dist/lab/runner.js serve --data-dir /data --port 3000
node dist/lab/runner.js run --data-dir /data --universes N --agents N --ticks N
```

The server must bind to `0.0.0.0:3000` inside the container and return a 2xx
response from `/healthz`.

The current logical runner is intended to finish normally. Do not terminate a
scientific run: an interrupted append-only stream is preserved for diagnosis
and is deliberately not resumed in logical v1. The long-running observer does
handle `SIGTERM` gracefully. Durable tick-boundary cancellation/resume remains
a prerequisite for long population jobs.

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
- a dedicated rotated authentication middleware or SSO middleware.

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

To override a value without creating a repository-local secret file, export it
in the shell or provide an env file stored outside the repository:

```bash
export ANU_LAB_TICKS=10000
export ANU_LAB_AGENTS=64
docker compose -f compose.lab.yml --profile runner run --rm lab-runner
```

Large runs are intentionally opt-in. The current server should be benchmarked
before increasing concurrency or running many physical node containers.

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

After rotating the authentication boundary, start the public variant explicitly
(do not run both observer variants unless two readers are intentional):

```bash
docker compose --env-file .env.example -f compose.lab.yml --profile edge \
  up -d --build lab-observer-edge
```

Verify the public route after the edge observer becomes healthy:

```bash
curl --fail --silent --show-error --head https://lab.anu.xteam.pro/healthz
```

The existing authentication middleware may return `401 Unauthorized` to an
unauthenticated request; that confirms the route is protected. Use the Traefik
dashboard or container health state to distinguish an auth response from an
unhealthy backend.

Before enabling the Traefik router, set `ANU_LAB_AUTH_MIDDLEWARE` to a rotated
middleware or real SSO. The checked-in value deliberately names a nonexistent
fail-closed placeholder. The server's current `infra-auth-dev@docker` uses a
placeholder-like Basic Auth identity and must not be reused until it is rotated.
Keep the observer off the edge network until that check is complete.

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
rotated container logs, and a read-only evidence mount for the observer.

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
