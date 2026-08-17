import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { startObserverServer } from "../dist/lab/observer.js";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeRun(dataDir, relativeDirectory, manifest, summary, events = []) {
  const runDirectory = join(dataDir, relativeDirectory);
  await mkdir(runDirectory, { recursive: true });
  await writeJson(join(runDirectory, "manifest.json"), manifest);
  if (summary !== null) await writeJson(join(runDirectory, "summary.json"), summary);
  if (events.length > 0) {
    await writeFile(
      join(runDirectory, "events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
  }
  return runDirectory;
}

async function startFixture(t, dataDir) {
  const server = await startObserverServer({ dataDir, host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("observer serves deterministic, paginated and redacted evidence over real HTTP", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir);

  await writeRun(
    dataDir,
    "runs/genesis-1/U0002",
    {
      schemaVersion: 1,
      experimentId: "genesis-1",
      runId: "zeta-run",
      universeId: "U0002",
      seed: "seed-zeta",
    },
    { schemaVersion: 1, runId: "zeta-run", ticks: 10, events: 2 },
  );
  await writeRun(
    dataDir,
    "runs/genesis-1/U0001",
    {
      schemaVersion: 1,
      experimentId: "genesis-1",
      runId: "alpha-run",
      universeId: "U0001",
      seed: "seed-alpha",
      apiKey: "must-never-leak",
    },
    {
      schemaVersion: 1,
      runId: "alpha-run",
      ticks: 20,
      events: 4,
      credentials: "also-must-never-leak",
    },
    [
      { seq: 1, type: "run.started", data: {} },
      { seq: 2, type: "task.created", data: { authorization: "Bearer top-secret" } },
      { seq: 3, type: "task.evaluated", data: { accepted: true } },
      { seq: 4, type: "run.completed", data: { note: "password=hunter2" } },
    ],
  );

  const baseUrl = await startFixture(t, dataDir);

  const rootResponse = await fetch(`${baseUrl}/`);
  assert.equal(rootResponse.status, 200);
  assert.deepEqual((await rootResponse.json()).links, {
    health: "/healthz",
    readiness: "/readyz",
    runs: "/api/runs",
  });

  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get("cache-control"), "no-store");
  assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(healthResponse.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.deepEqual(await healthResponse.json(), { status: "ok" });

  const readyResponse = await fetch(`${baseUrl}/readyz`);
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), { status: "ready" });

  const runsResponse = await fetch(`${baseUrl}/api/runs`);
  assert.equal(runsResponse.status, 200);
  const runs = await runsResponse.json();
  assert.equal(runs.count, 2);
  assert.deepEqual(runs.runs.map((run) => run.runId), ["alpha-run", "zeta-run"]);
  assert.deepEqual(runs.runs.map((run) => run.universeId), ["U0001", "U0002"]);

  const detailResponse = await fetch(`${baseUrl}/api/runs/alpha-run`);
  assert.equal(detailResponse.status, 200);
  const detailText = await detailResponse.text();
  assert.doesNotMatch(detailText, /must-never-leak|also-must-never-leak/);
  const detail = JSON.parse(detailText);
  assert.equal(detail.manifest.apiKey, "[REDACTED]");
  assert.equal(detail.summary.credentials, "[REDACTED]");

  const firstPageResponse = await fetch(`${baseUrl}/api/runs/alpha-run/events?after=1&limit=2`);
  assert.equal(firstPageResponse.status, 200);
  const firstPageText = await firstPageResponse.text();
  assert.doesNotMatch(firstPageText, /top-secret/);
  const firstPage = JSON.parse(firstPageText);
  assert.deepEqual(firstPage.events.map((event) => event.seq), [2, 3]);
  assert.equal(firstPage.events[0].data.authorization, "[REDACTED]");
  assert.equal(firstPage.nextAfter, 3);
  assert.equal(firstPage.hasMore, true);

  const lastPageResponse = await fetch(`${baseUrl}/api/runs/alpha-run/events?after=3&limit=2`);
  assert.equal(lastPageResponse.status, 200);
  const lastPageText = await lastPageResponse.text();
  assert.doesNotMatch(lastPageText, /hunter2/);
  const lastPage = JSON.parse(lastPageText);
  assert.deepEqual(lastPage.events.map((event) => event.seq), [4]);
  assert.equal(lastPage.nextAfter, 4);
  assert.equal(lastPage.hasMore, false);
});

test("observer rejects writes, traversal and unsafe or unbounded queries", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-security-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir);
  await writeRun(
    dataDir,
    "safe-run",
    { schemaVersion: 1, experimentId: "genesis-1", runId: "safe-run", universeId: "U1" },
    null,
    [{ seq: 1, type: "run.started", data: {} }],
  );

  const baseUrl = await startFixture(t, dataDir);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${baseUrl}/api/runs`, { method, body: "ignored" });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET");
    assert.deepEqual(await response.json(), { error: "method_not_allowed" });
  }

  const traversal = await fetch(`${baseUrl}/api/runs/..%2Foutside`);
  assert.equal(traversal.status, 400);
  assert.deepEqual(await traversal.json(), { error: "invalid_request_target" });

  const oversizedLimit = await fetch(`${baseUrl}/api/runs/safe-run/events?limit=1001`);
  assert.equal(oversizedLimit.status, 400);
  const negativeCursor = await fetch(`${baseUrl}/api/runs/safe-run/events?after=-1`);
  assert.equal(negativeCursor.status, 400);
  const duplicateCursor = await fetch(`${baseUrl}/api/runs/safe-run/events?after=0&after=1`);
  assert.equal(duplicateCursor.status, 400);
  const unknownQuery = await fetch(`${baseUrl}/api/runs/safe-run/events?path=/etc/passwd`);
  assert.equal(unknownQuery.status, 400);
});

test("observer ignores symlinked runs and never follows symlinked artifacts", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-symlink-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  const outsideRun = join(fixtureRoot, "outside-run");
  await mkdir(dataDir);
  await writeRun(
    fixtureRoot,
    "outside-run",
    { schemaVersion: 1, experimentId: "genesis-1", runId: "escaped-run", universeId: "escaped" },
    { ticks: 999, events: 999, password: "outside-secret" },
  );
  await symlink(outsideRun, join(dataDir, "escaped-link"), "dir");

  const safeDirectory = await writeRun(
    dataDir,
    "safe-run",
    { schemaVersion: 1, experimentId: "genesis-1", runId: "safe-run", universeId: "U1" },
    null,
  );
  const outsideSummary = join(fixtureRoot, "outside-summary.json");
  await writeJson(outsideSummary, { ticks: 999, password: "outside-secret" });
  await symlink(outsideSummary, join(safeDirectory, "summary.json"), "file");

  const baseUrl = await startFixture(t, dataDir);
  const listResponse = await fetch(`${baseUrl}/api/runs`);
  assert.equal(listResponse.status, 200);
  const listText = await listResponse.text();
  assert.doesNotMatch(listText, /escaped-run|outside-secret/);
  const list = JSON.parse(listText);
  assert.deepEqual(list.runs.map((run) => run.runId), ["safe-run"]);
  assert.equal(list.runs[0].summaryAvailable, false);

  const detailResponse = await fetch(`${baseUrl}/api/runs/safe-run`);
  assert.equal(detailResponse.status, 422);
  const detailText = await detailResponse.text();
  assert.doesNotMatch(detailText, /outside-secret|outside-summary/);
  assert.deepEqual(JSON.parse(detailText), { error: "invalid_artifact" });
});

test("health remains live while readiness and evidence fail closed for a missing data directory", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-missing-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const missingDataDir = join(fixtureRoot, "not-created");
  const baseUrl = await startFixture(t, missingDataDir);

  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
  const runsResponse = await fetch(`${baseUrl}/api/runs`);
  assert.equal(runsResponse.status, 503);
  assert.deepEqual(await runsResponse.json(), { error: "not_ready" });
});
