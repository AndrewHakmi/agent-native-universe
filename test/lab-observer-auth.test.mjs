import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { createObserverServer, startObserverServer } from "../dist/lab/observer.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_TOKEN = "anu_observer_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const REPLACEMENT_TOKEN = "anu_observer_replacement_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

async function listen(dataDir, authToken) {
  const server = await startObserverServer({ dataDir, host: "127.0.0.1", port: 0, authToken });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
}

test("application Bearer auth protects evidence routes without breaking probes or HTTP semantics", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-auth-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const { baseUrl, server } = await listen(fixtureRoot, AUTH_TOKEN);
  t.after(() => closeServer(server));

  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/`)).status, 200);

  for (const path of ["/api/runs", "/api/runs/missing", "/api/runs/missing/events"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="anu-lab-observer"');
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }

  for (const authorization of [undefined, "Basic dXNlcjpwYXNz", `bearer ${AUTH_TOKEN}`, "Bearer wrong-token"]) {
    const response = await fetch(`${baseUrl}/api/runs`, {
      headers: authorization === undefined ? {} : { Authorization: authorization },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="anu-lab-observer"');
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: "unauthorized" });
    assert.doesNotMatch(body, /anu_observer|wrong-token|dXNlcjpwYXNz/);
  }

  const authorized = await fetch(`${baseUrl}/api/runs`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { count: 0, runs: [], truncated: false });
  for (const path of ["/api/runs/missing", "/api/runs/missing/events"]) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "run_not_found" });
  }

  const writeAttempt = await fetch(`${baseUrl}/api/runs`, { method: "POST" });
  assert.equal(writeAttempt.status, 405);
  assert.equal(writeAttempt.headers.get("allow"), "GET");
  assert.equal(writeAttempt.headers.get("www-authenticate"), null);
  assert.deepEqual(await writeAttempt.json(), { error: "method_not_allowed" });

  const unknown = await fetch(`${baseUrl}/api/not-an-evidence-route`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not_found" });
});

test("internal observer remains unauthenticated and weak application tokens fail before listen", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-internal-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const internal = await startObserverServer({ dataDir: fixtureRoot, host: "127.0.0.1", port: 0 });
  t.after(() => closeServer(internal));
  const address = internal.address();
  assert.ok(address !== null && typeof address === "object");
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/runs`)).status, 200);

  const weakTokens = ["short", `${AUTH_TOKEN} `, `${AUTH_TOKEN}\nsecond-line`];
  for (const weakToken of weakTokens) {
    assert.throws(
      () => createObserverServer({ dataDir: fixtureRoot, authToken: weakToken }),
      (error) => {
        assert.match(error.message, /Observer auth token must be 32\.\.4096 bytes/);
        assert.equal(error.message.includes(weakToken), false);
        return true;
      },
    );
  }
});

test("serve reads a file-mounted token once, accepts a conventional final newline and never logs it", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-auth-cli-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  const tokenFile = join(fixtureRoot, "observer-token");
  await mkdir(dataDir);
  await writeFile(tokenFile, `${AUTH_TOKEN}\r\n`, { mode: 0o600 });

  const child = spawn(
    process.execPath,
    [
      "dist/lab/runner.js",
      "serve",
      "--data-dir",
      dataDir,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--auth-token-file",
      tokenFile,
    ],
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
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const listening = new Promise((resolveListening, rejectListening) => {
    const timeout = setTimeout(() => rejectListening(new Error("observer did not listen")), 5_000);
    lines.on("line", (line) => {
      const parsed = JSON.parse(line);
      if (parsed.status === "listening") {
        clearTimeout(timeout);
        resolveListening(parsed);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectListening(new Error(`observer exited before listening: code=${code} signal=${signal}`));
    });
  });

  const started = await listening;
  assert.equal(started.authentication, "bearer");
  assert.ok(Number.isInteger(started.port) && started.port > 0);
  const baseUrl = `http://127.0.0.1:${started.port}`;
  assert.equal((await fetch(`${baseUrl}/api/runs`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  })).status, 200);

  await writeFile(tokenFile, `${REPLACEMENT_TOKEN}\n`, { mode: 0o600 });
  assert.equal((await fetch(`${baseUrl}/api/runs`, {
    headers: { Authorization: `Bearer ${REPLACEMENT_TOKEN}` },
  })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/runs`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  })).status, 200);

  assert.equal(child.kill("SIGTERM"), true);
  const [exitCode, signal] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  assert.equal(stderr, "");
  assert.equal(stdout.includes(AUTH_TOKEN), false);
  assert.equal(stdout.includes(REPLACEMENT_TOKEN), false);
});

test("serve fails closed on an empty or missing token file without leaking token material", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "anu-observer-auth-invalid-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const dataDir = join(fixtureRoot, "data");
  const emptyTokenFile = join(fixtureRoot, "empty-token");
  await mkdir(dataDir);
  await writeFile(emptyTokenFile, "");

  for (const tokenFile of [emptyTokenFile, join(fixtureRoot, "missing-token")]) {
    const result = spawnSync(
      process.execPath,
      [
        "dist/lab/runner.js",
        "serve",
        "--data-dir",
        dataDir,
        "--port",
        "0",
        "--auth-token-file",
        tokenFile,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.command, "serve");
    assert.equal(failure.status, "error");
    assert.equal(failure.error.code, "command_failed");
    assert.doesNotMatch(result.stderr, /anu_observer|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  }
});
