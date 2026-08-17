import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  LAB_SCHEMA_VERSION,
  type RunEvidenceAttestation,
} from "./types.js";

export const RUN_EVIDENCE_ATTESTATION_DOMAIN =
  "agent-native-universe/lab/evidence-attestation/v1";
export const RUN_EVIDENCE_ATTESTATION_FORMAT = "anu-lab-evidence-attestation";

export type RunEvidenceAttestationBody = Omit<RunEvidenceAttestation, "commitment">;

/**
 * Validate only the portable attestation envelope and its self-commitment.
 * Evidence-to-attestation consistency requires a full replay and is handled by
 * verifyRunEvidenceAttestationLocalConsistency.
 */
export function validateRunEvidenceAttestation(
  value: unknown,
): asserts value is RunEvidenceAttestation {
  assertExactKeys(value, [
    "commitment",
    "evidence",
    "format",
    "hashAlgorithm",
    "labSchemaVersion",
    "scope",
    "subject",
    "version",
  ], "attestation");
  if (
    value.format !== RUN_EVIDENCE_ATTESTATION_FORMAT
    || value.version !== 1
    || value.hashAlgorithm !== "sha256"
    || value.labSchemaVersion !== LAB_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported final attestation format");
  }
  assertExactKeys(value.subject, [
    "engineVersion",
    "experimentId",
    "policyId",
    "runId",
    "taskGeneratorId",
    "universeId",
  ], "attestation subject");
  for (const [key, subjectValue] of Object.entries(value.subject)) {
    if (typeof subjectValue !== "string" || subjectValue.length === 0 || subjectValue.length > 256) {
      throw new Error(`Invalid attestation subject ${key}`);
    }
  }
  assertExactKeys(value.scope, ["kind", "seq", "tick"], "attestation scope");
  const tick = value.scope.tick;
  const seq = value.scope.seq;
  if (
    value.scope.kind !== "final"
    || typeof tick !== "number"
    || !Number.isSafeInteger(tick)
    || tick < 1
    || typeof seq !== "number"
    || !Number.isSafeInteger(seq)
    || seq < 1
  ) {
    throw new Error("Invalid final attestation scope");
  }
  assertExactKeys(value.evidence, [
    "configHash",
    "eventHash",
    "manifestHash",
    "metricsHash",
    "stateHash",
    "summaryHash",
  ], "attestation evidence");
  for (const [key, digest] of Object.entries(value.evidence)) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`Invalid attestation evidence hash ${key}`);
    }
  }
  validateRunEvidenceCommitment(value.commitment);
  const attestation = value as unknown as RunEvidenceAttestation;
  const { commitment: _commitment, ...body } = attestation;
  if (value.commitment !== computeRunEvidenceCommitment(body)) {
    throw new Error("Final attestation commitment is invalid");
  }
}

export function validateRunEvidenceCommitment(
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error("Expected external commitment must be sha256 followed by a lowercase 64-hex digest");
  }
}

export function computeRunEvidenceCommitment(
  body: RunEvidenceAttestationBody,
): string {
  return `sha256:${sha256Hex(
    `${RUN_EVIDENCE_ATTESTATION_DOMAIN}\0${canonicalJson(body)}`,
  )}`;
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid ${label} fields`);
  }
}
