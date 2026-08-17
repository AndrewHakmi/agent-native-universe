# Route map

There are no existing HTTP routes or frontend routes. The current executable interface is the `anu` CLI in `src/cli/index.ts`.

Planned Observer surface:

- `/` — population and universe overview.
- `/universes/{id}` — one universe timeline, graph, metrics, pressures, and evidence.
- `/api/runs` — read-only run discovery.
- `/api/runs/{id}` — read-only manifest and summary.
- `/api/runs/{id}/events` — paginated observable event stream.
- `/healthz` — liveness only.

No planned route may instruct an agent, assign a role, alter a result, or invoke Docker.
