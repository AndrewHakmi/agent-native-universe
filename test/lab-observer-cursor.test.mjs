import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startObserverServer } from "../dist/lab/observer.js";

const OLD_PREFIX_SCAN_LIMIT = 67_108_864;

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

function eventLine(seq, paddingBytes = 0, host = "example.test") {
  return `${JSON.stringify({
    seq,
    type: "cursor.test",
    data: {
      endpoint: `https://observer-user:observer-password@${host}/evidence`,
      padding: "x".repeat(paddingBytes),
    },
  })}\n`;
}

async function fetchEventPage(baseUrl, after, limit) {
  const response = await fetch(`${baseUrl}/api/runs/cursor-run/events?after=${after}&limit=${limit}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function writeRawRun(dataDir, runId, events) {
  const runDirectory = join(dataDir, runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      experimentId: "cursor-validation-test",
      runId,
      universeId: `U-${runId}`,
    })}\n`,
    "utf8",
  );
  await writeFile(join(runDirectory, "events.jsonl"), events, "utf8");
}

test("observer seeks high cursors without scanning a greater-than-64 MiB prefix", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-cursor-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const runDirectory = join(fixtureRoot, "data", "cursor-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      experimentId: "cursor-test",
      runId: "cursor-run",
      universeId: "U-cursor",
    })}\n`,
    "utf8",
  );

  const eventsPath = join(runDirectory, "events.jsonl");
  const eventPaddingBytes = 200_000;
  const eventCount = 360;
  const handle = await open(eventsPath, "w");
  try {
    for (let seq = 1; seq <= eventCount; seq += 1) {
      await handle.write(eventLine(seq, eventPaddingBytes));
    }
  } finally {
    await handle.close();
  }
  assert.ok(Buffer.byteLength(eventLine(1, eventPaddingBytes)) * 350 > OLD_PREFIX_SCAN_LIMIT);

  const baseUrl = await startFixture(t, join(fixtureRoot, "data"));

  const highPage = await fetchEventPage(baseUrl, 350, 3);
  assert.deepEqual(highPage.events.map((event) => event.seq), [351, 352, 353]);
  assert.equal(highPage.nextAfter, 353);
  assert.equal(highPage.hasMore, true);

  const repeatedPage = await fetchEventPage(baseUrl, 350, 3);
  assert.deepEqual(repeatedPage, highPage);

  const lowPage = await fetchEventPage(baseUrl, 0, 2);
  assert.deepEqual(lowPage.events.map((event) => event.seq), [1, 2]);
  assert.equal(
    lowPage.events[0].data.endpoint,
    "https://[REDACTED]@example.test/evidence",
  );
  assert.equal(lowPage.nextAfter, 2);
  assert.equal(lowPage.hasMore, true);

  await appendFile(eventsPath, eventLine(361, eventPaddingBytes), "utf8");
  const appendedPage = await fetchEventPage(baseUrl, 359, 3);
  assert.deepEqual(appendedPage.events.map((event) => event.seq), [360, 361]);
  assert.equal(appendedPage.nextAfter, 361);
  assert.equal(appendedPage.hasMore, false);

  await writeFile(eventsPath, `${eventLine(1)}${eventLine(2)}${eventLine(3)}`, "utf8");
  const truncatedPage = await fetchEventPage(baseUrl, 2, 3);
  assert.deepEqual(truncatedPage.events.map((event) => event.seq), [3]);
  assert.equal(truncatedPage.nextAfter, 3);
  assert.equal(truncatedPage.hasMore, false);

  await writeFile(
    eventsPath,
    `${eventLine(1, 0, "changed.test")}${eventLine(2, 0, "changed.test")}${eventLine(3, 0, "changed.test")}`,
    "utf8",
  );
  const mutatedPage = await fetchEventPage(baseUrl, 0, 3);
  assert.deepEqual(mutatedPage.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(mutatedPage.events[0].data.endpoint, "https://[REDACTED]@changed.test/evidence");
  assert.equal(mutatedPage.nextAfter, 3);
  assert.equal(mutatedPage.hasMore, false);
});

test("observer rejects truncated, blank, CRLF and locally non-contiguous event logs", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-cursor-invalid-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir, { recursive: true });

  await writeRawRun(dataDir, "truncated-run", eventLine(1).slice(0, -1));
  await writeRawRun(dataDir, "blank-run", `${eventLine(1)}\n${eventLine(2)}`);
  await writeRawRun(dataDir, "crlf-run", eventLine(1).replace("\n", "\r\n"));
  await writeRawRun(dataDir, "gap-run", `${eventLine(1)}${eventLine(3)}`);
  const invalidUtf8 = Buffer.from(eventLine(1));
  invalidUtf8[invalidUtf8.indexOf(Buffer.from("example.test"))] = 0xff;
  await writeRawRun(dataDir, "invalid-utf8-run", invalidUtf8);

  const baseUrl = await startFixture(t, dataDir);
  for (const runId of [
    "truncated-run", "blank-run", "crlf-run", "gap-run", "invalid-utf8-run",
  ]) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}/events?after=0&limit=100`);
    assert.equal(response.status, 422, runId);
    assert.deepEqual(await response.json(), { error: "invalid_event_log" }, runId);
  }
});
