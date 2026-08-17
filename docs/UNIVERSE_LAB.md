# Universe Lab

Universe Lab is an event-sourced experimental layer above the Agent Native
Universe runtime. Its first experiment, Genesis-1, asks a narrow question:

> Can initially role-neutral agents produce useful organization under finite
> resources and externally verified tasks without being assigned human job
> titles, teams, services, or workflows?

The lab does not treat an agent's self-description as evidence. Functional
specialization is inferred only from observable actions, accepted submissions,
resource flows, topology, and capability use.

## Boundary of authority

`LogicalUniverse` owns only the world's physics: logical time, public tasks,
hidden evaluator oracles, prices, finite resource balances, external pressures,
and append-only evidence. Every Genesis agent starts from the same role-free
state and runs the same `NeutralPolicy`; each agent receives an independent
seeded random stream and only its permitted observation.

The world never exposes expected task results. Agents submit candidate results,
and `IndependentEvaluator` records quality and latency independently. The
control plane cannot tell an agent what role to assume.

## Deterministic tick pipeline

Genesis state is created at tick 0. Experiment ticks are numbered from 1 through
the configured limit and execute these phases in order:

1. apply configured external pressures;
2. expire overdue work and generate public tasks;
3. create an immutable local observation for every active agent;
4. obtain role-free policy decisions;
5. resolve simultaneous decisions in a seeded shuffled order;
6. evaluate submissions against hidden immutable oracles;
7. record fixed-point metrics, a tick boundary, and scheduled checkpoints.

No scientific ID, event, seed, or state hash depends on wall-clock time,
`Math.random`, process scheduling, or host locale. Population workers derive
each universe seed from the base seed and universe ID, so changing `--parallel`
does not change results.

The manifest also binds the logical engine, policy, task-generator identity,
and execution mode. A semantic engine change therefore produces a different
run identity even when seed and experiment JSON stay the same.

## Evidence and replay

Each universe is stored under:

```text
runs/genesis-1/U0001/
├── manifest.json
├── config.json
├── events.jsonl
├── metrics.jsonl
├── summary.json
└── checkpoints/
    └── <tick>.json
```

Events are canonical JSONL with a monotonic sequence, deterministic event ID,
previous hash, and SHA-256 event hash. Writes are serialized through one
recorder. Replay verifies the complete chain before reducing events into state;
Genesis completion additionally compares replayed and live state hashes.
Immutable artifacts refuse conflicting replacement, and incomplete evidence is
preserved for diagnosis rather than silently resumed or deleted.

The chain makes accidental corruption, truncation, and ordinary tampering
detectable. It is not an external signature or transparency log: an attacker
with write access to every artifact could replace the manifest and recompute a
new chain. Long-term evidence should anchor the final hash in an independently
controlled signed store.

## Resource physics and pressure

Credits, model tokens, compute milliseconds, storage bytes, and bandwidth bytes
are non-negative safe integers. An action cost is transferred from the agent to
the world treasury, never destroyed. Every tick checks conservation across all
agents and the treasury. An externally accepted task transfers the configured
reward back from treasury; cumulative gross action spend is tracked separately
from the current balances. Genesis-1 applies exactly one instance of each
logical pressure:

- resource-price multiplier;
- bandwidth-capacity multiplier;
- deterministic fractional agent retirement;
- task-load multiplier.

The reference configuration in `experiments/genesis-1/config.json` contains 64
agents, 10,000 ticks, the specified finite global budget, and pressures at ticks
2,000, 3,500, 5,000, and 6,500.

## Commands

Build first, then use either the package binary or the dedicated runner:

```bash
npm run build

node dist/lab/runner.js genesis-1 \
  --data-dir ./runs \
  --config ./experiments/genesis-1/config.json \
  --universe-id U0001

node dist/lab/runner.js population \
  --data-dir ./runs \
  --config ./experiments/genesis-1/config.json \
  --universes 32 \
  --parallel 8

node dist/lab/runner.js replay \
  --data-dir ./runs \
  --universe-id U0001 \
  --until-tick 5000

node dist/lab/runner.js serve --data-dir ./runs --host 0.0.0.0 --port 3000
```

The same surface is available as `anu lab ...`. With no `--config`, the runner
uses a conservative 16-agent, 500-tick configuration suitable for a smoke run.

The observer exposes only read methods: health, readiness, the run catalogue,
run summaries, and paginated events. It cannot mutate or steer a universe.

## Scope of logical v1

The current implementation establishes the deterministic experimental control
plane, not a positive result for the research hypothesis. It includes role-free
deterministic cognition, eight task families, external evaluation, primitive
action costs, topology changes, capability contracts, population execution,
metrics, pressure, replay, and read-only observation.

Several experiments remain intentionally separate:

- local and external LLM cohorts with inference responses captured as replay
  inputs;
- physical four-node universes for transport, BFT, partition, and crash tests;
- LLM gateway egress, provider billing, and provider-failure pressure;
- evolutionary selection, recombination, and control populations;
- signed external anchoring of final evidence hashes;
- implementation of logical-v1 `spawn`, `clone`, `merge`, `reserve`, and `trade`
  actions (they are currently charged and recorded as unsupported attempts).

Consequently, a successful run proves reproducible execution and measurement;
it does not by itself prove emergence. Claims of specialization or organization
require repeated populations, action-derived labels, controls, and a
multidimensional comparison rather than one aggregate score.
