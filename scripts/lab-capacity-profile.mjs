#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createGenesisAgents } from "../dist/lab/agent-factory.js";
import { createRunManifest } from "../dist/lab/manifest.js";
import { NeutralPolicy } from "../dist/lab/neutral-policy.js";
import { decidePolicyTick } from "../dist/lab/policy-schedule.js";
import { initialWorldState } from "../dist/lab/reducer.js";
import { DeterministicRng } from "../dist/lab/rng.js";
import { DeterministicTaskStream } from "../dist/lab/task-stream.js";

if (typeof global.gc !== "function") {
  throw new Error("Run this profile with node --expose-gc");
}
if (process.argv.length !== 2) {
  throw new Error("Usage: node --expose-gc scripts/lab-capacity-profile.mjs (current checkout only)");
}

const configUrl = new URL("../experiments/genesis-1/config.json", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const manifest = createRunManifest(config, "U0001");
const state = initialWorldState(manifest);
for (const agent of createGenesisAgents(config)) state.agents[agent.id] = agent;

const taskStream = new DeterministicTaskStream(
  config.taskStream,
  new DeterministicRng("capacity-ladder"),
);
const samples = new Set([1_000, 3_000, 4_999, 5_000, 6_500, 7_000, 8_000, 9_000, 10_000]);

process.stdout.write(`${JSON.stringify({
  kind: "anu-lab-capacity-profile",
  version: 1,
  mode: "current-checkout",
  scope: "synthetic-policy-observation-hot-path",
  engineVersion: manifest.engineVersion,
  agents: config.agents,
  ticks: config.ticks,
  samplesPerTick: 1,
  gcBeforeEachSample: true,
  baselineIncluded: false,
  warning: "This excludes reducer, event I/O, replay, checkpoints, and population scheduling.",
})}\n`);

for (let tick = 1; tick <= config.ticks; tick += 1) {
  if (tick === 5_000) {
    for (const agent of Object.values(state.agents).slice(0, 12)) {
      agent.active = false;
      agent.retiredTick = tick;
    }
  }

  const tasksThisTick = tick < 6_500 ? 1 : 10;
  for (const { task } of taskStream.generate(tick, tasksThisTick)) state.tasks[task.id] = task;
  if (!samples.has(tick)) continue;

  for (const task of Object.values(state.tasks)) {
    if (task.deadlineTick < tick) task.status = "expired";
  }
  state.tick = tick - 1;
  global.gc();

  const startedAt = process.hrtime.bigint();
  let batch = decidePolicyTick(
    state,
    tick,
    new NeutralPolicy(),
    new DeterministicRng(`sample-${tick}`),
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  process.stdout.write(`${JSON.stringify({
    kind: "sample",
    tick,
    tasks: Object.keys(state.tasks).length,
    visibleTasks: batch.observations[0]?.tasks.length ?? 0,
    agents: batch.observations.length,
    decisions: batch.decisions.length,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
  })}\n`);
  batch = null;
}
