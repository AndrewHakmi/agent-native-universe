import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function invoke(entrypoint, args) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseSingleJson(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, text);
  return JSON.parse(lines[0]);
}

test("anu lab delegates to the strict structured runner without changing existing commands", () => {
  const help = invoke("dist/cli/index.js", ["lab", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(parseSingleJson(help.stdout).status, "ok");

  const directHelp = invoke("dist/lab/runner.js", ["--help"]);
  assert.equal(directHelp.status, 0, directHelp.stderr);
  assert.equal(parseSingleJson(directHelp.stdout).usage, "anu lab <command> [options]");

  const invalid = invoke("dist/cli/index.js", ["lab", "population", "--universes", "01"]);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.deepEqual(parseSingleJson(invalid.stderr), {
    command: "population",
    status: "error",
    error: { code: "invalid_usage", message: "--universes must be an integer" },
  });

  const unknown = invoke("dist/lab/runner.js", ["serve", "--write", "yes"]);
  assert.equal(unknown.status, 2);
  assert.equal(parseSingleJson(unknown.stderr).error.code, "invalid_usage");

  const principles = invoke("dist/cli/index.js", ["principles"]);
  assert.equal(principles.status, 0, principles.stderr);
  assert.match(principles.stdout, /Local worlds, explicit boundaries/);
});

test("run aliases population, conserves finite resources and produces replayable evidence", async (t) => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "anu-lab-cli-run-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));

  const run = invoke("dist/cli/index.js", [
    "lab",
    "run",
    "--data-dir",
    evidenceRoot,
    "--universes",
    "2",
    "--parallel",
    "2",
    "--agents",
    "2",
    "--ticks",
    "1",
    "--metric-every",
    "1",
    "--checkpoint-every",
    "1",
    "--seed",
    "cli-test",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const output = parseSingleJson(run.stdout);
  assert.equal(output.command, "run");
  assert.equal(output.mode, "population");
  assert.equal(output.status, "completed");
  assert.deepEqual(output.population.universes.map((summary) => summary.universeId), ["U0001", "U0002"]);

  for (const summary of output.population.universes) {
    const config = JSON.parse(await readFile(
      join(evidenceRoot, "genesis-1", summary.universeId, summary.runId, "config.json"),
      "utf8",
    ));
    assert.equal(config.agents, 2);
    assert.equal(config.initialResources.credits * config.agents + config.treasuryResources.credits, 100_000);
  }

  const replay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--until-tick",
    "1",
  ]);
  assert.equal(replay.status, 0, replay.stderr);
  const replayOutput = parseSingleJson(replay.stdout);
  assert.equal(replayOutput.status, "completed");
  assert.equal(replayOutput.replay.stateHash, output.population.universes[0].finalStateHash);
  assert.equal(replayOutput.replay.state.completed, true);

  const secondRun = invoke("dist/lab/runner.js", [
    "genesis-1",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--agents",
    "2",
    "--ticks",
    "1",
    "--metric-every",
    "1",
    "--checkpoint-every",
    "1",
    "--seed",
    "cli-test-second-run",
  ]);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  const secondSummary = parseSingleJson(secondRun.stdout).summary;
  assert.notEqual(secondSummary.runId, output.population.universes[0].runId);

  const ambiguousReplay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
  ]);
  assert.equal(ambiguousReplay.status, 1);
  assert.match(
    parseSingleJson(ambiguousReplay.stderr).error.message,
    /Multiple supported evidence runs.*--run-id/,
  );

  const explicitReplay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    output.population.universes[0].runId,
  ]);
  assert.equal(explicitReplay.status, 0, explicitReplay.stderr);
  assert.equal(
    parseSingleJson(explicitReplay.stdout).replay.stateHash,
    output.population.universes[0].finalStateHash,
  );

  const unsafeReplay = invoke("dist/lab/runner.js", [
    "replay",
    "--data-dir",
    evidenceRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    "../outside",
  ]);
  assert.equal(unsafeReplay.status, 2);
  assert.match(parseSingleJson(unsafeReplay.stderr).error.message, /safe evidence run identifier/);

  const impossiblePopulation = invoke("dist/lab/runner.js", [
    "population",
    "--data-dir",
    join(evidenceRoot, "impossible"),
    "--agents",
    "101",
  ]);
  assert.equal(impossiblePopulation.status, 2);
  assert.match(parseSingleJson(impossiblePopulation.stderr).error.message, /finite credits budget/);
});

test("serve binds all interfaces by default and closes gracefully on SIGTERM", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-lab-cli-serve-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir);

  const child = spawn(
    process.execPath,
    ["dist/lab/runner.js", "serve", "--data-dir", dataDir, "--port", "0"],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const stdoutLines = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const linesClosed = once(lines, "close");
  const listening = new Promise((resolveListening, rejectListening) => {
    const timeout = setTimeout(
      () => rejectListening(new Error(`observer did not listen; stderr=${stderr}`)),
      5_000,
    );
    lines.on("line", (line) => {
      const parsed = JSON.parse(line);
      stdoutLines.push(parsed);
      if (parsed.status === "listening") {
        clearTimeout(timeout);
        resolveListening(parsed);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectListening(new Error(`observer exited before listening: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });

  const started = await listening;
  assert.equal(started.command, "serve");
  assert.equal(started.host, "0.0.0.0");
  assert.ok(Number.isInteger(started.port) && started.port > 0);
  const health = await fetch(`http://127.0.0.1:${started.port}/healthz`);
  assert.equal(health.status, 200);

  assert.equal(child.kill("SIGTERM"), true);
  const [exitCode, signal] = await once(child, "exit");
  await linesClosed;
  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  assert.deepEqual(stdoutLines.map((line) => line.status), ["listening", "stopping", "stopped"]);
  assert.equal(stderr, "");
});
