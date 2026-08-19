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

## Completed v1 reference-universe canary

On 2026-08-19 the v1 release-candidate runtime completed one immutable
reference universe from `experiments/genesis-1/config.json` on this host: Node.js
22.14.0, 8 vCPUs, Intel Xeon Gold 6458Q. The measured command was:

```bash
node dist/lab/runner.js genesis-1 \
  --config ./experiments/genesis-1/config.json \
  --data-dir /tmp/anu-v1-canary \
  --universe-id U0001
```

The interval from manifest creation through the atomically committed summary
was 4,494.6 seconds. Evidence mtimes place live completion at 2,313.9 seconds;
the mandatory full semantic replay, final hashing, summary, and attestation
occupied the remaining 2,180.7 seconds. These are one-run wall-clock
observations, not statistical throughput claims.

Measured evidence and process facts:

- 64 initial agents, 52 active agents at tick 10,000, and 115 active links in
  one connected component;
- 41,509 tasks, 131,372 canonical events, and zero recorded violations;
- 69,931,927 event-log bytes and 47,738 metric-history bytes;
- 100 complete checkpoints; the tick-10,000 checkpoint was 15,097,607 bytes;
- 701,400,591 total run-directory bytes;
- highest sampled `VmHWM` 780,500 kB (about 762 MiB), with no swap;
- final event hash
  `02bbf72e31cdf1e76634442aa39dc7a84c7bbddb8f823179d50b612da1447a68`;
- final state hash
  `a082072c9f2258f2dcdd0bbf6db86e158ea32e607679f6a04806e4b66431c137`;
- attestation commitment
  `sha256:29a9876c5d9e41268460a3badf41ffc0d7e312eb50ec03f04a1bafb364b375d9`.

This closes the single-universe canary item. It also confirms the remaining
bottlenecks: full checkpoints dominate disk, and authoritative replay consumes
CPU time comparable to live execution as task history grows.

A separate `verify-attestation` invocation then reopened one held five-artifact
snapshot, repeated authoritative semantic replay, matched the externally
supplied commitment above, and returned `status: verified`. Verification did
not modify the run directory.

## Current conclusion

One `64 × 10,000` reference universe now completes with replay-equivalent,
attested evidence. The complete `32 × 64 × 10,000` target remains unvalidated.
Before declaring population capacity:

1. eliminate full task-history scans in expiry/backlog maintenance;
2. benchmark an anchored persistent event writer instead of open/write/close
   for every event;
3. replace full-world checkpoints with a lower-amplification representation;
4. profile process-worker CPU, RSS, IPC, and evidence-writer contention;
5. scale the same immutable config through guarded multi-universe stages before
   attempting all 32 universes.

Tick-boundary pause/resume is now durable: a checkpoint includes deterministic
task-generator and neutral-policy RNG state, and resume requires independent
semantic replay to match the checkpoint state, event-chain tail, and runtime
hash. This improves operability but does not reduce snapshot size; checkpoints
still contain the complete projected world.

Interrupted and failed runs are intentionally preserved as diagnostic evidence,
so capacity planning must reserve space for unsuccessful attempts as well as the
final population.
