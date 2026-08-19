import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { canonicalJson } from "../dist/lab/canonical.js";
import { startObserverServer } from "../dist/lab/observer.js";
import {
  OBSERVER_UI_CSS,
  OBSERVER_UI_HTML,
  OBSERVER_UI_JAVASCRIPT,
} from "../dist/lab/observer-ui.js";

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

function cssToken(name) {
  const match = OBSERVER_UI_CSS.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, "i"));
  assert.ok(match, `missing CSS token --${name}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test("Observer UI is self-contained, accessible by structure, and syntactically valid", () => {
  assert.doesNotThrow(() => new Script(OBSERVER_UI_JAVASCRIPT));
  assert.doesNotMatch(OBSERVER_UI_HTML, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(OBSERVER_UI_JAVASCRIPT, /localStorage|sessionStorage|innerHTML/);
  assert.match(OBSERVER_UI_HTML, /<main\b/);
  assert.match(OBSERVER_UI_HTML, /<aside\b/);
  assert.match(OBSERVER_UI_HTML, /aria-live=/);
  assert.match(OBSERVER_UI_HTML, /Accessible data table/);
  assert.match(OBSERVER_UI_HTML, /class="breadcrumbs" role="navigation" aria-label="Evidence location"/);
  assert.match(OBSERVER_UI_HTML, /class="legend" role="group" aria-label="Chart legend"/);
  assert.match(OBSERVER_UI_CSS, /\[hidden\] \{ display: none !important; \}/);
  assert.match(OBSERVER_UI_CSS, /prefers-reduced-motion/);
});

test("Observer text palette meets WCAG AA contrast on every base surface", () => {
  const foregrounds = ["ink", "muted", "subtle", "green", "cyan", "violet", "amber", "danger"];
  const backgrounds = ["canvas", "panel", "raised", "raised-2"];
  for (const foreground of foregrounds) {
    for (const background of backgrounds) {
      assert.ok(
        contrastRatio(cssToken(foreground), cssToken(background)) >= 4.5,
        `--${foreground} must have 4.5:1 contrast on --${background}`,
      );
    }
  }
});

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
  const alphaRunDirectory = await writeRun(
    dataDir,
    "runs/genesis-1/U0001",
    {
      schemaVersion: 1,
      experimentId: "genesis-1",
      runId: "alpha-run",
      universeId: "U0001",
      seed: "seed-alpha",
      apiKey: "must-never-leak",
      authToken: "auth-token-must-never-leak",
    },
    {
      schemaVersion: 1,
      runId: "alpha-run",
      ticks: 20,
      events: 4,
      credentials: "also-must-never-leak",
      csrfToken: "csrf-token-must-never-leak",
    },
    [
      { seq: 1, type: "run.started", data: {} },
      { seq: 2, type: "task.created", data: { authorization: "Bearer top-secret" } },
      { seq: 3, type: "task.evaluated", data: { accepted: true } },
      { seq: 4, type: "run.completed", data: { note: "password=hunter2" } },
    ],
  );
  await writeFile(
    join(alphaRunDirectory, "metrics.jsonl"),
    [
      {
        schemaVersion: 1,
        tick: 10,
        taskSuccessRatePpm: 500_000,
        meanQualityPpm: 750_000,
        densityPpm: 100_000,
        activeAgents: 16,
        activeLinks: 12,
      },
      {
        schemaVersion: 1,
        tick: 20,
        taskSuccessRatePpm: 800_000,
        meanQualityPpm: 900_000,
        densityPpm: 240_000,
        activeAgents: 15,
        activeLinks: 24,
      },
    ].map((metric) => canonicalJson(metric)).join("\n") + "\n",
    "utf8",
  );
  await writeRun(
    dataDir,
    "runs/genesis-1/U0001/run:addressed",
    {
      schemaVersion: 1,
      experimentId: "genesis-1",
      runId: "run:addressed",
      universeId: "U0001",
      seed: "seed-addressed",
    },
    { schemaVersion: 1, runId: "run:addressed", ticks: 1, events: 1 },
    [{ seq: 1, type: "run.started", data: {} }],
  );

  const baseUrl = await startFixture(t, dataDir);

  const rootResponse = await fetch(`${baseUrl}/`);
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(rootResponse.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  const rootHtml = await rootResponse.text();
  assert.match(rootHtml, /<main class="workspace"/);
  assert.match(rootHtml, /ANU Observer/);
  assert.doesNotMatch(rootHtml, /<script(?![^>]*\bsrc=)/);

  const stylesheetResponse = await fetch(`${baseUrl}/assets/observer.css`);
  assert.equal(stylesheetResponse.status, 200);
  assert.match(stylesheetResponse.headers.get("content-type") ?? "", /^text\/css/);
  assert.match(await stylesheetResponse.text(), /prefers-reduced-motion/);
  const scriptResponse = await fetch(`${baseUrl}/assets/observer.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.match(await scriptResponse.text(), /Bearer token/);

  const serviceResponse = await fetch(`${baseUrl}/api`);
  assert.equal(serviceResponse.status, 200);
  const service = await serviceResponse.json();
  assert.equal(service.version, "1.0.0");
  assert.deepEqual(service.links, {
    ui: "/",
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
  assert.equal(runs.count, 3);
  assert.deepEqual(runs.runs.map((run) => run.runId), ["alpha-run", "run:addressed", "zeta-run"]);
  assert.deepEqual(runs.runs.map((run) => run.universeId), ["U0001", "U0001", "U0002"]);

  const addressedDetailResponse = await fetch(`${baseUrl}/api/runs/run%3Aaddressed`);
  assert.equal(addressedDetailResponse.status, 200);
  assert.equal((await addressedDetailResponse.json()).runId, "run:addressed");

  const detailResponse = await fetch(`${baseUrl}/api/runs/alpha-run`);
  assert.equal(detailResponse.status, 200);
  const detailText = await detailResponse.text();
  assert.doesNotMatch(
    detailText,
    /must-never-leak|also-must-never-leak|auth-token-must-never-leak|csrf-token-must-never-leak/,
  );
  const detail = JSON.parse(detailText);
  assert.equal(detail.manifest.apiKey, "[REDACTED]");
  assert.equal(detail.manifest.authToken, "[REDACTED]");
  assert.equal(detail.summary.credentials, "[REDACTED]");
  assert.equal(detail.summary.csrfToken, "[REDACTED]");

  const metricsResponse = await fetch(`${baseUrl}/api/runs/alpha-run/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.deepEqual(await metricsResponse.json(), {
    runId: "alpha-run",
    count: 2,
    metrics: [
      {
        schemaVersion: 1,
        tick: 10,
        taskSuccessRatePpm: 500_000,
        meanQualityPpm: 750_000,
        densityPpm: 100_000,
        activeAgents: 16,
        activeLinks: 12,
      },
      {
        schemaVersion: 1,
        tick: 20,
        taskSuccessRatePpm: 800_000,
        meanQualityPpm: 900_000,
        densityPpm: 240_000,
        activeAgents: 15,
        activeLinks: 24,
      },
    ],
  });

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
  const metricsQuery = await fetch(`${baseUrl}/api/runs/safe-run/metrics?limit=1`);
  assert.equal(metricsQuery.status, 400);
});

test("observer never selects one of two evidence directories with the same run id", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-duplicate-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir);
  const duplicateManifest = {
    schemaVersion: 1,
    experimentId: "genesis-1",
    runId: "duplicate-run",
    universeId: "U0001",
  };
  await writeRun(dataDir, "copy-a", duplicateManifest, null);
  await writeRun(dataDir, "copy-b", duplicateManifest, null);
  await writeRun(
    dataDir,
    "unique",
    { ...duplicateManifest, runId: "unique-run", universeId: "U0002" },
    null,
  );

  const baseUrl = await startFixture(t, dataDir);
  const catalogueResponse = await fetch(`${baseUrl}/api/runs`);
  assert.equal(catalogueResponse.status, 409);
  assert.deepEqual(await catalogueResponse.json(), { error: "ambiguous_run_evidence" });
  for (const runId of ["duplicate-run", "unique-run"]) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "ambiguous_run_evidence" });
  }
});

test("observer never resolves a run when discovery exceeds the catalogue bound", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-boundary-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir);

  for (let start = 0; start < 1_000; start += 50) {
    const end = Math.min(start + 50, 1_000);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset;
      return writeRun(
        dataDir,
        `directory-${String(index).padStart(4, "0")}`,
        {
          schemaVersion: 1,
          experimentId: "genesis-1",
          runId: `boundary-run-${String(index).padStart(4, "0")}`,
          universeId: `U${String(index + 1).padStart(4, "0")}`,
        },
        null,
      );
    }));
  }

  const baseUrl = await startFixture(t, dataDir);
  const exactLimitResponse = await fetch(`${baseUrl}/api/runs`);
  assert.equal(exactLimitResponse.status, 200);
  const exactLimit = await exactLimitResponse.json();
  assert.equal(exactLimit.count, 1_000);
  assert.equal(exactLimit.truncated, false);

  await writeRun(
    dataDir,
    "directory-1000",
    {
      schemaVersion: 1,
      experimentId: "genesis-1",
      runId: "boundary-run-0000",
      universeId: "U1001",
    },
    null,
  );
  for (const path of [
    "/api/runs",
    "/api/runs/boundary-run-0000",
    "/api/runs/boundary-run-0999/events",
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "run_discovery_incomplete" });
  }
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
