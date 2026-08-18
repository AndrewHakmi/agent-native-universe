import type { RunEvidenceAttestation } from "./types.js";

type FinalAttestationWriter = (attestation: RunEvidenceAttestation) => Promise<void>;

const finalAttestationWriters = new WeakMap<object, FinalAttestationWriter>();

/** @internal Register the private immutable writer owned by EvidenceStore. */
export function registerFinalAttestationWriter(
  store: object,
  writer: FinalAttestationWriter,
): void {
  if (finalAttestationWriters.has(store)) {
    throw new Error("Final attestation writer is already registered");
  }
  finalAttestationWriters.set(store, writer);
}

/**
 * @internal This module is deliberately absent from the public lab barrel.
 * Callers must first derive the value from replay-verified evidence.
 */
export async function writeFinalAttestationInternal(
  store: object,
  attestation: RunEvidenceAttestation,
): Promise<void> {
  const writer = finalAttestationWriters.get(store);
  if (writer === undefined) throw new TypeError("Unsupported evidence store instance");
  await writer(attestation);
}
