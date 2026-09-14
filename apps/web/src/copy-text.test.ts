import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText, manualCopyGuidance } from "./copy-text";

afterEach(() => vi.unstubAllGlobals());

describe("copyText", () => {
  it("uses the asynchronous Clipboard API when the browser exposes it", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("task-123")).resolves.toEqual({ copied: true });
    expect(writeText).toHaveBeenCalledWith("task-123");
  });

  it("falls back to a temporary selected textarea when Clipboard API is unavailable on HTTP", async () => {
    const select = vi.fn();
    const remove = vi.fn();
    const textarea = { value: "", style: {}, setAttribute: vi.fn(), select, remove };
    const append = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      createElement: vi.fn(() => textarea),
      body: { append },
      execCommand,
    });

    await expect(copyText("task-456")).resolves.toEqual({ copied: true });
    expect(textarea.value).toBe("task-456");
    expect(append).toHaveBeenCalledWith(textarea);
    expect(select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("returns actionable manual-copy guidance when browser copy is blocked", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);

    await expect(copyText("task-789")).resolves.toEqual({
      copied: false,
      guidance: manualCopyGuidance,
    });
  });

  it("returns manual-copy guidance when the legacy HTTP fallback is present but blocked", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      body: { append: vi.fn(() => Promise.reject(new Error("blocked"))) },
      createElement: vi.fn(() => {
        throw new Error("DOM mutation blocked");
      }),
      execCommand: vi.fn(() => false),
    });

    await expect(copyText("task-legacy")).resolves.toEqual({
      copied: false,
      guidance: manualCopyGuidance,
    });
  });
});
