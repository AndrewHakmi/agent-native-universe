import { hashValue } from "./canonical.js";

export type DeterministicIdPart = string | number;

/** Create a readable, deterministic ID without clocks, randomness, or process state. */
export function deterministicId(...parts: readonly DeterministicIdPart[]): string {
  if (parts.length === 0) throw new TypeError("deterministicId requires at least one part");
  for (const part of parts) {
    if (typeof part === "number" && !Number.isSafeInteger(part)) {
      throw new RangeError("Numeric deterministic ID parts must be safe integers");
    }
  }
  const rawPrefix = typeof parts[0] === "string" ? parts[0] : "id";
  const prefix = rawPrefix.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "id";
  const digest = hashValue({ domain: "agent-native-universe/lab/id/v1", parts });
  return `${prefix}:${digest.slice(0, 32)}`;
}
