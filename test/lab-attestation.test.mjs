import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EvidenceStore } from "../dist/lab/artifacts.js";
import { canonicalJson } from "../dist/lab/canonical.js";
import { DEFAULT_GENESIS_CONFIG } from "../dist/lab/config.js";
import {
  attestRunEvidence,
  computeRunEvidenceCommitment,
  validateRunEvidenceAttestation,
  verifyRunEvidenceAttestation,
  verifyRunEvidenceAttestationLocalConsistency,
} from "../dist/lab/evidence-attestation.js";
import { runGenesis } from "../dist/lab/genesis.js";
import { startObserverServer } from "../dist/lab/observer.js";
import { ReplayEngine } from "../dist/lab/replay.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function attestationConfig(seed) {
  const config = structuredClone(DEFAULT_GENESIS_CONFIG);
  config.seed = seed;
  config.ticks = 2;
  config.metricEvery = 1;
  config.checkpointEvery = 2;
  return config;
}

function invoke(args) {
  return spawnSync(process.execPath, ["dist/lab/runner.js", ...args], {
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

test("final attestations are deterministic, automatic, immutable and externally verifiable", async (t) => {
  const firstRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-b-"));
  t.after(() => Promise.all([
    rm(firstRoot, { recursive: true, force: true }),
    rm(secondRoot, { recursive: true, force: true }),
  ]));

  const config = attestationConfig("attestation-determinism");
  const firstSummary = await runGenesis({ config, runsRoot: firstRoot, universeId: "U0001" });
  const secondSummary = await runGenesis({ config, runsRoot: secondRoot, universeId: "U0001" });
  assert.deepEqual(firstSummary, secondSummary);

  const first = await EvidenceStore.openExisting(
    firstRoot,
    config.experimentId,
    "U0001",
    firstSummary.runId,
  );
  const second = await EvidenceStore.openExisting(
    secondRoot,
    config.experimentId,
    "U0001",
    secondSummary.runId,
  );
  const firstStored = await first.readFinalAttestation();
  const secondStored = await second.readFinalAttestation();
  assert.ok(firstStored);
  assert.deepEqual(firstStored, secondStored);
  assert.match(firstStored.commitment, /^sha256:[0-9a-f]{64}$/);
  assert.equal(firstStored.scope.seq, firstSummary.events);
  assert.equal(firstStored.evidence.eventHash, firstSummary.finalEventHash);
  assert.equal(firstStored.evidence.stateHash, firstSummary.finalStateHash);
  validateRunEvidenceAttestation(firstStored);

  assert.deepEqual(await attestRunEvidence(first), firstStored, "attest must be idempotent");
  assert.deepEqual(
    await verifyRunEvidenceAttestation(first, firstStored.commitment),
    firstStored,
  );
  await assert.rejects(
    verifyRunEvidenceAttestation(first),
    /Expected external commitment/,
  );
  await assert.rejects(
    verifyRunEvidenceAttestation(first, `sha256:${"0".repeat(64)}`),
    /commitment mismatch/,
  );
  assert.throws(
    () => validateRunEvidenceAttestation({ ...firstStored, unexpected: true }),
    /attestation fields/,
  );

  const raw = await readFile(first.finalAttestationPath, "utf8");
  assert.equal(raw, canonicalJson(firstStored), "attestation artifact must be canonical JSON");

  const server = await startObserverServer({ dataDir: firstRoot, host: "127.0.0.1", port: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runs/${firstSummary.runId}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.deepEqual(detail.attestation, firstStored);
    assert.equal(detail.attestationStatus, "self_consistent");
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    }));
  }
});

test("attestation verification rejects a summary rewritten after anchoring", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-tamper-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const config = attestationConfig("attestation-summary-tamper");
  const summary = await runGenesis({ config, runsRoot, universeId: "U0001" });
  const evidence = await EvidenceStore.openExisting(
    runsRoot,
    config.experimentId,
    "U0001",
    summary.runId,
  );
  const stored = JSON.parse(await readFile(evidence.summaryPath, "utf8"));
  stored.finalStateHash = "f".repeat(64);
  await writeFile(evidence.summaryPath, canonicalJson(stored), "utf8");
  await assert.rejects(
    verifyRunEvidenceAttestationLocalConsistency(evidence),
    /Stored summary does not match verified evidence/,
  );
});

test("attestation verification bounds metrics evidence before materializing it", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-metrics-limit-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const config = attestationConfig("attestation-metrics-limit");
  const summary = await runGenesis({ config, runsRoot, universeId: "U0001" });
  const evidence = await EvidenceStore.openExisting(
    runsRoot,
    config.experimentId,
    "U0001",
    summary.runId,
  );
  await truncate(evidence.metricsPath, 67_108_865);
  await assert.rejects(
    verifyRunEvidenceAttestationLocalConsistency(evidence),
    /67108864-byte read limit/,
  );
});

test("attestation verification rejects evidence changed during replay", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-race-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const config = attestationConfig("attestation-race");
  const summary = await runGenesis({ config, runsRoot, universeId: "U0001" });
  const evidence = await EvidenceStore.openExisting(
    runsRoot,
    config.experimentId,
    "U0001",
    summary.runId,
  );
  const replayHandle = ReplayEngine.replayHandle;
  ReplayEngine.replayHandle = async (...args) => {
    const replay = await replayHandle.apply(ReplayEngine, args);
    const unchangedSummary = await readFile(evidence.summaryPath, "utf8");
    await writeFile(evidence.summaryPath, unchangedSummary, "utf8");
    return replay;
  };
  try {
    await assert.rejects(
      verifyRunEvidenceAttestationLocalConsistency(evidence),
      /Evidence artifact changed during verification: summary/,
    );
  } finally {
    ReplayEngine.replayHandle = replayHandle;
  }
});

test("attestation verification replays held events and fails closed on pathname swaps", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-swap-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const config = attestationConfig("attestation-swap");
  const summary = await runGenesis({ config, runsRoot, universeId: "U0001" });
  const evidence = await EvidenceStore.openExisting(
    runsRoot,
    config.experimentId,
    "U0001",
    summary.runId,
  );
  const backupPath = `${evidence.eventsPath}.held-original`;
  const replayHandle = ReplayEngine.replayHandle;
  let swapped = false;
  ReplayEngine.replayHandle = async (...args) => {
    await rename(evidence.eventsPath, backupPath);
    await writeFile(evidence.eventsPath, "{}\n", "utf8");
    try {
      const replay = await replayHandle.apply(ReplayEngine, args);
      swapped = true;
      return replay;
    } finally {
      await rm(evidence.eventsPath, { force: true });
      await rename(backupPath, evidence.eventsPath);
    }
  };
  try {
    await assert.rejects(
      verifyRunEvidenceAttestationLocalConsistency(evidence),
      /Evidence artifact changed during verification: events/,
    );
    assert.equal(swapped, true);
  } finally {
    ReplayEngine.replayHandle = replayHandle;
  }
});

test("attestation storage rejects public writes and invalid stored envelopes", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-storage-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const config = attestationConfig("attestation-storage-boundary");
  const summary = await runGenesis({ config, runsRoot, universeId: "U0001" });
  const evidence = await EvidenceStore.openExisting(
    runsRoot,
    config.experimentId,
    "U0001",
    summary.runId,
  );
  const stored = await evidence.readFinalAttestation();
  assert.ok(stored);

  const { commitment: _commitment, ...forgedBody } = structuredClone(stored);
  forgedBody.evidence.stateHash = "0".repeat(64);
  const forged = {
    ...forgedBody,
    commitment: computeRunEvidenceCommitment(forgedBody),
  };
  validateRunEvidenceAttestation(forged);
  assert.equal(evidence.writeFinalAttestation, undefined);
  await assert.rejects(
    Promise.resolve().then(() => evidence.writeFinalAttestation(forged)),
    /is not a function/,
  );
  assert.deepEqual(await evidence.readFinalAttestation(), stored);

  const { commitment: _foreignCommitment, ...foreignBody } = structuredClone(stored);
  foreignBody.subject.runId = "run-foreign-attestation";
  const foreign = {
    ...foreignBody,
    commitment: computeRunEvidenceCommitment(foreignBody),
  };
  validateRunEvidenceAttestation(foreign);
  await writeFile(evidence.finalAttestationPath, canonicalJson(foreign), "utf8");
  await assert.rejects(evidence.readFinalAttestation(), /does not match its evidence run/);

  const server = await startObserverServer({ dataDir: runsRoot, host: "127.0.0.1", port: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/runs/${summary.runId}`;
    const foreignResponse = await fetch(url);
    assert.equal(foreignResponse.status, 200);
    const foreignDetail = await foreignResponse.json();
    assert.equal(foreignDetail.attestation, null);
    assert.equal(foreignDetail.attestationStatus, "invalid");

    await writeFile(
      evidence.finalAttestationPath,
      canonicalJson({ ...stored, unexpected: true }),
      "utf8",
    );
    await assert.rejects(evidence.readFinalAttestation(), /attestation fields/);
    const malformedResponse = await fetch(url);
    assert.equal(malformedResponse.status, 200);
    const malformedDetail = await malformedResponse.json();
    assert.equal(malformedDetail.attestation, null);
    assert.equal(malformedDetail.attestationStatus, "invalid");

    await rm(evidence.finalAttestationPath);
    const legacyResponse = await fetch(url);
    assert.equal(legacyResponse.status, 200);
    const legacyDetail = await legacyResponse.json();
    assert.equal(legacyDetail.attestation, null);
    assert.equal(legacyDetail.attestationStatus, "missing");

    const alternate = join(evidence.directory, "alternate-attestations");
    await mkdir(alternate);
    await writeFile(join(alternate, "final.json"), canonicalJson(stored), "utf8");
    await rm(evidence.attestationsDirectory, { recursive: true });
    await symlink("alternate-attestations", evidence.attestationsDirectory, "dir");
    const symlinkResponse = await fetch(url);
    assert.equal(symlinkResponse.status, 200);
    const symlinkDetail = await symlinkResponse.json();
    assert.equal(symlinkDetail.attestation, null);
    assert.equal(symlinkDetail.attestationStatus, "invalid");
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    }));
  }
});

test("attest and verify-attestation CLI expose a publishable commitment", async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), "anu-lab-attestation-cli-"));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const run = invoke([
    "genesis-1",
    "--data-dir",
    runsRoot,
    "--universe-id",
    "U0001",
    "--ticks",
    "1",
    "--metric-every",
    "1",
    "--checkpoint-every",
    "1",
    "--seed",
    "attestation-cli",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const summary = parseSingleJson(run.stdout).summary;
  const legacyEvidence = await EvidenceStore.openExisting(
    runsRoot,
    "genesis-1",
    "U0001",
    summary.runId,
  );
  await rm(legacyEvidence.finalAttestationPath);

  const attest = invoke([
    "attest",
    "--data-dir",
    runsRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    summary.runId,
  ]);
  assert.equal(attest.status, 0, attest.stderr);
  const attestation = parseSingleJson(attest.stdout).attestation;
  assert.deepEqual(await legacyEvidence.readFinalAttestation(), attestation);

  const verify = invoke([
    "verify-attestation",
    "--data-dir",
    runsRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    summary.runId,
    "--expected",
    attestation.commitment,
  ]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(parseSingleJson(verify.stdout).status, "verified");

  const malformed = invoke([
    "verify-attestation",
    "--data-dir",
    runsRoot,
    "--expected",
    "SHA256:not-a-digest",
  ]);
  assert.equal(malformed.status, 2);
  assert.equal(parseSingleJson(malformed.stderr).error.code, "invalid_usage");

  const missingExpected = invoke([
    "verify-attestation",
    "--data-dir",
    runsRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    summary.runId,
  ]);
  assert.equal(missingExpected.status, 2);
  assert.equal(parseSingleJson(missingExpected.stderr).error.code, "invalid_usage");

  const mismatch = invoke([
    "verify-attestation",
    "--data-dir",
    runsRoot,
    "--universe-id",
    "U0001",
    "--run-id",
    summary.runId,
    "--expected",
    `sha256:${"0".repeat(64)}`,
  ]);
  assert.equal(mismatch.status, 1);
  assert.match(parseSingleJson(mismatch.stderr).error.message, /commitment mismatch/);
});
