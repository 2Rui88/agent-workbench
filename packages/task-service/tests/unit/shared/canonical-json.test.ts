import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  canonicalJsonString
} from "../../../src/shared/canonical-json.js";

describe("canonicalJsonString", () => {
  it("sorts object keys by UTF-8 byte order", () => {
    expect(canonicalJsonString({ b: 1, a: 2, "é": 3 })).toBe('{"a":2,"b":1,"é":3}');
  });

  it("sorts nested objects recursively and drops undefined members", () => {
    expect(canonicalJsonString({
      z: { y: [1, 0], x: { deep: "v" } },
      a: undefined,
      m: "kept"
    })).toBe('{"m":"kept","z":{"x":{"deep":"v"},"y":[1,0]}}');
  });

  it("preserves array order and renders scalars without whitespace", () => {
    expect(canonicalJsonString({ list: [3, 1, 2], flag: true, none: null }))
      .toBe('{"flag":true,"list":[3,1,2],"none":null}');
  });

  it("escapes strings exactly like JSON.stringify", () => {
    expect(canonicalJsonString({ text: "line\nbreak \"quoted\"" }))
      .toBe('{"text":"line\\nbreak \\"quoted\\""}');
  });

  it("produces stable output regardless of key insertion order", () => {
    const left = canonicalJsonString({ head: "abc", challenge: "id", v: 1 });
    const right = canonicalJsonString({ v: 1, head: "abc", challenge: "id" });
    expect(left).toBe(right);
  });

  it("rejects non-integer and non-finite numbers", () => {
    expect(() => canonicalJsonString({ v: 1.5 })).toThrow(TypeError);
    expect(() => canonicalJsonString({ v: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJsonString({ v: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("encodes to UTF-8 bytes for signing", () => {
    expect([...canonicalJsonBytes({ é: "ü" })]).toEqual(
      [...Buffer.from('{"é":"ü"}', "utf8")]
    );
  });
});
