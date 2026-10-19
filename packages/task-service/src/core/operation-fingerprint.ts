import { createHash } from "node:crypto";

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | {
  [key: string]: CanonicalJson;
};

function canonicalize(value: unknown, inArray = false): CanonicalJson | undefined {
  if (value === undefined) {
    if (inArray) {
      throw new TypeError("Undefined array entries are not valid semantic input");
    }
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Semantic input numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, true)!);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Semantic input contains unsupported ${typeof value} value`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Semantic input objects must have a plain prototype");
  }
  const result: { [key: string]: CanonicalJson } = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === "operation_id") {
      continue;
    }
    const canonical = canonicalize((value as Record<string, unknown>)[key]);
    if (canonical !== undefined) {
      result[key] = canonical;
    }
  }
  return result;
}

export function canonicalRequestHash(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError("Semantic input must contain a JSON value");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
