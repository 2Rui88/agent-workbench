import { describe, expect, it, vi } from "vitest";
import { copyText } from "../../../src/web/copy-text.js";

describe("copyText", () => {
  it("uses the Clipboard API when it succeeds", async () => {
    const writeText = vi.fn(async () => undefined);
    const legacyCopy = vi.fn(() => true);

    await expect(copyText("agent instruction", {
      clipboard: { writeText },
      legacyCopy
    })).resolves.toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith("agent instruction");
    expect(legacyCopy).not.toHaveBeenCalled();
  });

  it("uses the legacy path when the Clipboard API is unavailable", async () => {
    const legacyCopy = vi.fn(() => true);

    await expect(copyText("agent instruction", {
      clipboard: null,
      legacyCopy
    })).resolves.toBe("legacy");
    expect(legacyCopy).toHaveBeenCalledWith("agent instruction");
  });

  it("falls back when the Clipboard API rejects the request", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const legacyCopy = vi.fn(() => true);

    await expect(copyText("agent instruction", {
      clipboard: { writeText },
      legacyCopy
    })).resolves.toBe("legacy");
    expect(legacyCopy).toHaveBeenCalledWith("agent instruction");
  });

  it("rejects when neither copy strategy succeeds", async () => {
    await expect(copyText("agent instruction", {
      clipboard: null,
      legacyCopy: () => false
    })).rejects.toThrow("Browser did not allow copying text");
  });
});
