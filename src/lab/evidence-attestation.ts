import { EvidenceConflictError, EvidenceStore } from "./artifacts.js";
import { hashValue } from "./canonical.js";
import {
  computeRunEvidenceCommitment,
  RUN_EVIDENCE_ATTESTATION_FORMAT,
  validateRunEvidenceAttestation,
  validateRunEvidenceCommitment,
  type RunEvidenceAttestationBody,
} from "./evidence-attestation-schema.js";
import { writeFinalAttestationInternal } from "./evidence-attestation-storage.js";
import { verifyCompletedRunEvidence } from "./evidence-verifier.js";
import {
  LAB_SCHEMA_VERSION,
  type GenesisConfig,
  type MetricsSnapshot,
  type RunEvidenceAttestation,
  type RunManifest,
  type RunSummary,
} from "./types.js";

export {
  computeRunEvidenceCommitment,
  RUN_EVIDENCE_ATTESTATION_DOMAIN,
  RUN_EVIDENCE_ATTESTATION_FORMAT,
  validateRunEvidenceAttestation,
  validateRunEvidenceCommitment,
} from "./evidence-attestation-schema.js";

export function createRunEvidenceAttestation(
  manifest: RunManifest,
  config: GenesisConfig,
  summary: RunSummary,
  metrics: readonly MetricsSnapshot[],
): RunEvidenceAttestation {
  if (hashValue(config) !== manifest.configHash) {
    throw new Error("Attestation config does not match its manifest");
  }
  if (
    summary.schemaVersion !== LAB_SCHEMA_VERSION
    || summary.runId !== manifest.runId
    || summary.universeId !== manifest.universeId
    || summary.seed !== manifest.seed
  ) {
    throw new Error("Attestation summary does not match its manifest");
  }
  if (
    summary.ticks < 1
    || summary.events < 1
    || metrics.length < 1
    || hashValue(metrics.at(-1)) !== hashValue(summary.latestMetrics)
  ) {
    throw new Error("Attestation summary does not match its metrics");
  }

  const body: RunEvidenceAttestationBody = {
    format: RUN_EVIDENCE_ATTESTATION_FORMAT,
    version: 1,
    hashAlgorithm: "sha256",
    labSchemaVersion: LAB_SCHEMA_VERSION,
    subject: {
      experimentId: manifest.experimentId,
      runId: manifest.runId,
      universeId: manifest.universeId,
      engineVersion: manifest.engineVersion,
      policyId: manifest.policyId,
      taskGeneratorId: manifest.taskGeneratorId,
    },
    scope: {
      kind: "final",
      tick: summary.ticks,
      seq: summary.events,
    },
    evidence: {
      manifestHash: hashValue(manifest),
      configHash: hashValue(config),
      eventHash: summary.finalEventHash,
      stateHash: summary.finalStateHash,
      summaryHash: hashValue(summary),
      metricsHash: hashValue(metrics),
    },
  };
  return {
    ...body,
    commitment: computeRunEvidenceCommitment(body),
  };
}

export async function attestRunEvidence(
  evidence: EvidenceStore,
): Promise<RunEvidenceAttestation> {
  const verified = await verifyCompletedRunEvidence(evidence);
  const attestation = createRunEvidenceAttestation(
    verified.manifest,
    verified.config,
    verified.summary,
    verified.metrics,
  );
  const stored = await evidence.readFinalAttestation();
  if (stored !== undefined) {
    validateRunEvidenceAttestation(stored);
    if (hashValue(stored) !== hashValue(attestation)) {
      throw new EvidenceConflictError("Stored final attestation conflicts with verified evidence");
    }
    return structuredClone(stored);
  }
  await writeFinalAttestationInternal(evidence, attestation);
  return structuredClone(attestation);
}

export async function verifyRunEvidenceAttestationLocalConsistency(
  evidence: EvidenceStore,
): Promise<RunEvidenceAttestation> {
  const verified = await verifyCompletedRunEvidence(evidence);
  const recomputed = createRunEvidenceAttestation(
    verified.manifest,
    verified.config,
    verified.summary,
    verified.metrics,
  );
  const stored = await evidence.readFinalAttestation();
  if (stored === undefined) throw new Error("Evidence run has no final attestation");
  validateRunEvidenceAttestation(stored);
  if (hashValue(stored) !== hashValue(recomputed)) {
    throw new Error("Stored final attestation does not match verified evidence");
  }
  return structuredClone(stored);
}

/**
 * Verify local evidence and bind the result to a commitment obtained from an
 * independent system. The external commitment is intentionally mandatory.
 */
export async function verifyRunEvidenceAttestation(
  evidence: EvidenceStore,
  expectedCommitment: string,
): Promise<RunEvidenceAttestation> {
  validateRunEvidenceCommitment(expectedCommitment);
  const stored = await verifyRunEvidenceAttestationLocalConsistency(evidence);
  if (stored.commitment !== expectedCommitment) {
    throw new Error(
      `Final attestation commitment mismatch: expected ${expectedCommitment}, got ${stored.commitment}`,
    );
  }
  return structuredClone(stored);
}
