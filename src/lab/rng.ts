import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

const MASK_64 = (1n << 64n) - 1n;
const UINT64_RANGE = 1n << 64n;
const FLOAT53_DENOMINATOR = 9_007_199_254_740_992;

/** A deterministic xoshiro256** stream with consumption-independent forks. */
export class DeterministicRng {
  readonly #streamSeed: string;
  #state: [bigint, bigint, bigint, bigint];

  constructor(seed: string) {
    if (typeof seed !== "string" || seed.length === 0) throw new TypeError("RNG seed must be a non-empty string");
    this.#streamSeed = seed;
    this.#state = stateFromSeed(seed);
  }

  /** Forking does not consume or otherwise mutate the parent stream. */
  fork(label: string | number): DeterministicRng {
    if (typeof label === "number" && (!Number.isSafeInteger(label) || label < 0)) {
      throw new RangeError("Numeric RNG fork labels must be non-negative safe integers");
    }
    if (typeof label === "string" && label.length === 0) throw new TypeError("RNG fork label must not be empty");
    return new DeterministicRng(canonicalJson({
      domain: "agent-native-universe/lab/rng-fork/v1",
      parent: this.#streamSeed,
      label,
    }));
  }

  nextUint64(): bigint {
    const [s0, s1, s2, s3] = this.#state;
    const result = (rotateLeft((s1 * 5n) & MASK_64, 7n) * 9n) & MASK_64;
    const temporary = (s1 << 17n) & MASK_64;

    const n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    const n1 = s1 ^ n2;
    const n0 = s0 ^ n3;
    this.#state = [n0 & MASK_64, n1 & MASK_64, (n2 ^ temporary) & MASK_64, rotateLeft(n3, 45n)];
    return result;
  }

  nextFloat(): number {
    return Number(this.nextUint64() >> 11n) / FLOAT53_DENOMINATOR;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError("maxExclusive must be a positive safe integer");
    }
    const bound = BigInt(maxExclusive);
    const limit = UINT64_RANGE - (UINT64_RANGE % bound);
    let sample: bigint;
    do sample = this.nextUint64(); while (sample >= limit);
    return Number(sample % bound);
  }

  chancePpm(probabilityPpm: number): boolean {
    if (!Number.isSafeInteger(probabilityPpm) || probabilityPpm < 0 || probabilityPpm > 1_000_000) {
      throw new RangeError("probabilityPpm must be an integer between 0 and 1,000,000");
    }
    return this.nextInt(1_000_000) < probabilityPpm;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new RangeError("Cannot pick from an empty collection");
    return values[this.nextInt(values.length)] as T;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = this.nextInt(index + 1);
      const currentValue = shuffled[index] as T;
      shuffled[index] = shuffled[other] as T;
      shuffled[other] = currentValue;
    }
    return shuffled;
  }
}

function stateFromSeed(seed: string): [bigint, bigint, bigint, bigint] {
  const digest = createHash("sha256")
    .update("agent-native-universe/lab/rng-seed/v1\0", "utf8")
    .update(seed, "utf8")
    .digest();
  const state: [bigint, bigint, bigint, bigint] = [
    digest.readBigUInt64BE(0),
    digest.readBigUInt64BE(8),
    digest.readBigUInt64BE(16),
    digest.readBigUInt64BE(24),
  ];
  if (state.every((word) => word === 0n)) state[0] = 1n;
  return state;
}

function rotateLeft(value: bigint, shift: bigint): bigint {
  return ((value << shift) | (value >> (64n - shift))) & MASK_64;
}
