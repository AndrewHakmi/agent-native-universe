# ANU Observer

The Observer is the human and machine read-only surface for Universe Lab
evidence. It is served by the same dependency-free Node.js process as the JSON
API and performs no mutations.

## Human interface

Open / in a browser. The v1 interface provides:

- a searchable catalogue of completed and in-progress runs;
- evaluator-backed outcome metrics;
- metric history for success, quality, and graph density;
- structural signals for centralization, specialization, inequality, components,
  turnover, and latency;
- deterministic attestation status and copyable evidence commitments;
- a bounded, redacted event window with event-type filtering. Completed runs
  open near the tail; active runs open from the first valid page because they
  have no trusted terminal event count yet.

The chart has an accessible data table. Navigation and controls are keyboard
operable, layouts adapt to narrow viewports, and non-essential motion respects
prefers-reduced-motion.

The UI does not fabricate agent positions or role labels. Structural panels are
computed from recorded metrics. Event payloads are rendered as text, never as
HTML.

## Authentication

The internal Observer omits application authentication and must remain on the
isolated Compose control network.

When --auth-token-file is configured, all /api/runs... evidence routes require
one exact Bearer token. The routes /, /assets, /api, /healthz, and /readyz remain
public so the UI and infrastructure probes can load. The UI then asks for the
token and keeps it only in JavaScript memory:

- no cookie;
- no localStorage;
- no sessionStorage;
- no URL parameter;
- no log output.

Closing or locking the page clears the UI's reference. The edge deployment still
requires an independent ForwardAuth/SSO middleware; that middleware must not
consume the application's Authorization header.

## HTTP contract

All routes are GET only and reject request bodies.

| Route | Auth | Purpose |
| --- | --- | --- |
| / | No | Observer HTML |
| /assets/observer.css | No | Self-contained stylesheet |
| /assets/observer.js | No | Self-contained UI application |
| /api | No | Machine-readable service and link contract |
| /healthz | No | Process liveness |
| /readyz | No | Evidence-volume readiness |
| /api/runs | Conditional | Bounded run catalogue |
| /api/runs/:runId | Conditional | Manifest, summary, and attestation |
| /api/runs/:runId/metrics | Conditional | Bounded validated metric history |
| /api/runs/:runId/events?after=N&limit=N | Conditional | Cursor-paginated redacted events |

Metric history is limited to 8 MiB per Observer response. Oversized history is
rejected with 413 artifact_too_large; the underlying evidence verifier retains
its separately documented 64 MiB validation boundary. Event pages allow at most
1,000 records and 4 MiB of response data.

## Response security

The Observer sets a same-origin content security policy and denies framing,
cross-origin resource use, MIME sniffing, DNS prefetch, ambient browser
permissions, and referrer disclosure. Evidence responses are no-store.

These headers are defense in depth. TLS, HSTS, SSO, edge rate limits, and
in-flight request limits remain the reverse proxy's responsibility.
