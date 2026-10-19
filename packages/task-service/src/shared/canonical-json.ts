/// <reference types="node" />

/**
 * Deterministic JSON serialization shared by the host-evidence signer
 * (developer machine) and verifier (server). Identical payloads must produce
 * identical bytes on both sides, so the rules are deliberately strict:
 *
 * - object keys sorted by UTF-8 byte order,
 * - no insignificant whitespace,
 * - strings use JSON escaping (UTF-8 output),
 * - only finite integers are accepted for numbers (the evidence payload uses
 *   `v: 1` only; floats, NaN and Infinity are rejected),
 * - `undefined` object members are skipped, arrays keep their order.
 */
export function canonicalJsonString(value: unknown): string {
  return serialize(value);
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(serialize(value), "utf8");
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isInteger(value)) {
        throw new TypeError(
          `Canonical JSON supports finite integers only, received: ${String(value)}`
        );
      }
      return value.toString(10);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Unsupported canonical JSON value type: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined);
  entries.sort(([left], [right]) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  ));
  return `{${entries
    .map(([key, member]) => `${JSON.stringify(key)}:${serialize(member)}`)
    .join(",")}}`;
}
