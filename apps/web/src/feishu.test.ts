import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { requestFeishuAuthCode } from "./feishu";

describe("requestFeishuAuthCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the Feishu H5 SDK ready callback before requesting a code", async () => {
    let notifyReady: (() => void) | undefined;
    const requestAuthCode = vi.fn((options: { success(result: { code: string }): void }) => {
      options.success({ code: "code-from-feishu" });
    });

    vi.stubGlobal("window", {
      h5sdk: {
        ready(callback: () => void) {
          notifyReady = callback;
        },
      },
      tt: { requestAuthCode },
    });

    const result = requestFeishuAuthCode("cli_test");

    expect(requestAuthCode).not.toHaveBeenCalled();
    expect(notifyReady).toBeTypeOf("function");

    notifyReady?.();

    await expect(result).resolves.toBe("code-from-feishu");
    expect(requestAuthCode).toHaveBeenCalledWith(expect.objectContaining({ appId: "cli_test" }));
  });

  it("loads the official H5 SDK only when Feishu login needs it", async () => {
    type ScriptStub = {
      async: boolean;
      onerror?: () => void;
      onload?: () => void;
      src: string;
    };

    const script: ScriptStub = { async: false, src: "" };
    const requestAuthCode = vi.fn((options: { success(result: { code: string }): void }) => {
      options.success({ code: "on-demand-code" });
    });
    const windowStub: {
      h5sdk?: { ready(callback: () => void): void };
      tt?: { requestAuthCode: typeof requestAuthCode };
    } = {};

    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", {
      createElement: vi.fn(() => script),
      head: {
        appendChild(received: ScriptStub) {
          windowStub.h5sdk = { ready: (callback) => callback() };
          windowStub.tt = { requestAuthCode };
          received.onload?.();
        },
      },
    });

    await expect(requestFeishuAuthCode("cli_on_demand")).resolves.toBe("on-demand-code");
    expect(script.src).toBe("https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.48.js");
    expect(script.async).toBe(true);
  });

  it("does not load the Feishu bridge eagerly in ordinary browsers", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

    expect(html).not.toContain("h5-js-sdk-1.5.48.js");
  });
});
