import { describe, expect, it } from "vitest";
import { normalizeClientMetadata } from "../../../src/mcp/client-metadata.js";

describe("normalizeClientMetadata", () => {
  it("maps the known CLI clients onto platform client families", () => {
    expect(normalizeClientMetadata({ name: "codex-cli", version: "0.147.0" }).client_family)
      .toBe("codex");
    expect(normalizeClientMetadata({ name: "codex-mcp-client", version: "0.147.0" }).client_family)
      .toBe("codex");
    expect(normalizeClientMetadata({ name: "claude-code", version: "2.1.215" }).client_family)
      .toBe("claude_code");
  });

  it("falls back to a generic family for unknown clients", () => {
    expect(normalizeClientMetadata({ name: "unknown-agent", version: "1.0.0" }).client_family)
      .toBe("generic_mcp");
  });

  it("matches client names case-insensitively", () => {
    expect(normalizeClientMetadata({ name: "Codex-CLI", version: "0.147.0" }).client_family)
      .toBe("codex");
  });

  it("preserves the raw client name and version", () => {
    expect(normalizeClientMetadata({ name: "Claude-Code", version: "2.1.215" })).toEqual({
      client_family: "claude_code",
      client_name: "Claude-Code",
      client_version: "2.1.215"
    });
  });
});
