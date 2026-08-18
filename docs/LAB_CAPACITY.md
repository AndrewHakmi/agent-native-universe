# Universe Lab capacity envelope

This document separates measured engineering facts from extrapolation. It is
not evidence that the complete reference population has finished successfully.

## Reference target

`experiments/genesis-1/config.json` defines one universe with 64 initial agents
and 10,000 ticks. The intended population contains 32 independent universes.
The reference task pressure produces 41,509 historical tasks per universe.

`runPopulation()` now executes production universes in separate bounded Node.js
processes. `--parallel` is the maximum number of simultaneously active child
processes, so CPU-bound policy and reducer work can use multiple cores.
Injected test/integration executors remain in-process and are independently
verified before their output can enter a population catalogue.

## Per-tick observation projection

Previously every active agent scanned the entire historical task table and
rebuilt the same public capabilities and submission window on every tick. Full
semantic replay repeated that work. The scheduler now builds an immutable,
redacted per-tick snapshot once, then materializes resources, inbox, neighbors,
claimed tasks, and verification eligibility per agent. Structural sharing stays
internal; policy code receives a separate deeply frozen observation clone.
`ObservationFrame` is an implementation detail, not a new evidence or protocol
object.

The optimization is protocol-neutral:

- it does not change `WorldState`, event JSON, manifest identity, or engine ID;
- live execution and strict replay call the same `decidePolicyTick()` path;
- golden tests preserve exact event counts, final event hashes, and final state
  hashes across multiple seeds;
- an operation-count regression requires one full task-table scan per policy
  tick.

## Current hot-path profile and historical baseline

Build and reproduce the current-checkout profile with:

```bash
npm ci
npm run lab:capacity-profile
```

The script uses the reference config and deterministic task generator to
construct a synthetic target-shaped task archive. It applies the relevant
task-load and retirement shape, invokes explicit garbage collection, and takes
one timed `decidePolicyTick()` sample at each reported tick. It emits JSONL so
the current results can be retained verbatim. Reducer work, event I/O,
checkpoints, replay, and population scheduling are deliberately excluded.

The `Before` column below is a historical one-off measurement of the
pre-optimization source at commit
`926ab5f6a8c6c189c43eb882d09788832a08f113`. It used the same target-shaped
state construction on the same host, but the temporary baseline harness and raw
JSONL were not committed. Consequently, `npm run lab:capacity-profile`
reproduces only the current column; it does not reproduce `Before` or the
derived speed-up column. No `--mode baseline` is provided because reimplementing
the old path inside the new script would not be independent evidence of the old
implementation.

Both columns were measured on 2026-08-17 with Node.js 22.14.0 on an 8-vCPU
virtualized Intel Xeon Gold 6458Q host:

| Tick | Tasks | Active agents | Historical baseline (one-off) | Current profile | Indicative ratio |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1,000 | 64 | 83.6 ms | 47.1 ms | 1.8× |
| 5,000 | 5,000 | 52 | 102.9 ms | 36.9 ms | 2.8× |
| 7,000 | 11,509 | 52 | 654.2 ms | 280.5 ms | 2.3× |
| 9,000 | 31,509 | 52 | 925.7 ms | 279.7 ms | 3.3× |
| 10,000 | 41,509 | 52 | 1,126.7 ms | 286.5 ms | 3.9× |

The one-off final baseline sample used approximately 154 MiB RSS; the final
checkout sample used 124 MiB. Earlier current-path repeats measured 279.0 ms at
122 MiB and 282.5 ms at 125 MiB at tick 10,000. These wall-time and RSS
comparisons are host-sensitive and are not statistical performance claims.
Deterministic hashes, event counts, and the one-scan regression are the stable
correctness criteria. A checked-in baseline harness or results artifact would
be required before calling the historical comparison fully reproducible.

## Storage risk

The completed 16-agent × 500-tick validation produced 8,456 events and
4,781,044 event-log bytes, approximately 565 bytes per event. Depending on
emergent action volume, a 10,000-tick universe is currently estimated at roughly
96–375 MiB of event JSONL.

Checkpoints are the larger risk. A 100-tick checkpoint interval produces 100
complete world snapshots; historical task arrays alone can exceed 287 MiB per
universe. A 32-universe population can therefore exceed 20 GiB after events,
checkpoints, summaries, and failed preserved runs are included.

## Current conclusion

The policy hot path is materially improved, but the complete
`32 × 64 × 10,000` target remains unvalidated. Before declaring capacity:

1. eliminate full task-history scans in expiry/backlog maintenance;
2. benchmark an anchored persistent event writer instead of open/write/close
   for every event;
3. replace full-world checkpoints with a lower-amplification representation;
4. profile process-worker CPU, RSS, IPC, and evidence-writer contention;
5. run one 64-agent × 10,000-tick canary with disk and RSS telemetry;
6. only then scale the same immutable config to 32 universes.

Tick-boundary pause/resume is now durable: a checkpoint includes deterministic
task-generator and neutral-policy RNG state, and resume requires independent
semantic replay to match the checkpoint state, event-chain tail, and runtime
hash. This improves operability but does not reduce snapshot size; checkpoints
still contain the complete projected world.

Interrupted and failed runs are intentionally preserved as diagnostic evidence,
so capacity planning must reserve space for unsuccessful attempts as well as the
final population.
