import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import { createRunManifest } from "../dist/lab/manifest.js";

const require = createRequire(import.meta.url);

async function raceFixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-root-`));
  const outside = await mkdtemp(join(tmpdir(), `${prefix}-outside-`));
  const parent = join(root, "evidence");
  const displaced = join(root, "evidence-held");
  await mkdir(parent);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  return { root, outside, parent, displaced };
}

function injectRenameSymlinkAtFinalOpen(t, filename, fixture) {
  const fsPromises = require("node:fs/promises");
  const originalOpen = fsPromises.open;
  let triggered = false;
  fsPromises.open = async function hookedOpen(path, ...args) {
    if (!triggered && String(path).endsWith(`/${filename}`)) {
      triggered = true;
      await rename(fixture.parent, fixture.displaced);
      await symlink(fixture.outside, fixture.parent, "dir");
    }
    return originalOpen.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  });
  return () => triggered;
}

test("dirfd final open cannot be redirected by parent rename plus symlink", async (t) => {
  if (process.platform !== "linux") return t.skip("requires Linux /proc/self/fd");
  const fixture = await raceFixture(t, "anu-dirfd-open");
  const target = join(fixture.parent, "events.jsonl");
  const wasTriggered = injectRenameSymlinkAtFinalOpen(t, "events.jsonl", fixture);
  const { openRegularFileNoFollow } = await import(
    `../dist/lab/event-stream.js?dirfd-race=${Date.now()}`
  );

  const handle = await openRegularFileNoFollow(
    target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
  );
  try {
    await handle.writeFile("anchored\n", "utf8");
  } finally {
    await handle.close();
  }

  assert.equal(wasTriggered(), true, "the adversarial swap must occur at the final open");
  assert.equal(await readFile(join(fixture.displaced, "events.jsonl"), "utf8"), "anchored\n");
  await assert.rejects(
    readFile(join(fixture.outside, "events.jsonl"), "utf8"),
    (error) => error?.code === "ENOENT",
    "the symlink target must never receive evidence bytes",
  );
});

test("LabEventRecorder fails closed after an in-flight parent swap", async (t) => {
  if (process.platform !== "linux") return t.skip("requires Linux /proc/self/fd");
  const fixture = await raceFixture(t, "anu-dirfd-recorder");
  const target = join(fixture.parent, "events.jsonl");
  const wasTriggered = injectRenameSymlinkAtFinalOpen(t, "events.jsonl", fixture);
  const { LabEventRecorder } = await import(
    `../dist/lab/event-recorder.js?dirfd-race=${Date.now()}`
  );
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = "dirfd-parent-swap";
  const manifest = createRunManifest(config, "U0001");

  await assert.rejects(
    LabEventRecorder.open(target, manifest),
    /symbolic link|non-directory/,
  );
  assert.equal(wasTriggered(), true, "the adversarial swap must occur at the final open");
  assert.equal(await readFile(join(fixture.displaced, "events.jsonl"), "utf8"), "");
  await assert.rejects(
    readFile(join(fixture.outside, "events.jsonl"), "utf8"),
    (error) => error?.code === "ENOENT",
    "recorder creation must not escape the configured evidence root",
  );
});
