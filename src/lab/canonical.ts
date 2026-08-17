import { createHash } from "node:crypto";

/**
 * Serialize strict JSON with recursively sorted object keys.
 *
 * Scientific hashes must not depend on insertion order or host locale. Values
 * outside the JSON data model are rejected instead of being silently coerced.
 */
export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, "$", false);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Locale-independent UTF-16 code-unit ordering for scientific decisions. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeCanonical(value: unknown, path: string, arrayElement: boolean): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    case "undefined":
      if (arrayElement) throw new TypeError(`${path} contains undefined`);
      throw new TypeError(`${path} is undefined`);
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`${path} contains unsupported ${typeof value}`);
    case "object":
      break;
  }

  if (Array.isArray(value)) {
    const encoded: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`${path}[${index}] is a sparse array element`);
      encoded.push(encodeCanonical(value[index], `${path}[${index}]`, true));
    }
    return `[${encoded.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }

  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) throw new TypeError(`${path} contains symbol keys`);

  const record = value as Record<string, unknown>;
  // Explicit UTF-16 code-unit ordering is independent of process locale/ICU.
  const keys = Object.keys(record).sort(compareCodeUnits);
  const properties = keys.map((key) => {
    const encodedKey = JSON.stringify(key);
    const encodedValue = encodeCanonical(record[key], `${path}.${key}`, false);
    return `${encodedKey}:${encodedValue}`;
  });
  return `{${properties.join(",")}}`;
}
