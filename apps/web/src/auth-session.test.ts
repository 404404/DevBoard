import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginDevelopment, loginFeishu, readAuthBootstrap, readSession } from "./api";
import { requestFeishuAuthCode } from "./feishu";
import { restoreOrCreateSession } from "./auth-session";
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loginDevelopment: vi.fn(),
  loginFeishu: vi.fn(),
  readAuthBootstrap: vi.fn(),
  readSession: vi.fn(),
}));
vi.mock("./feishu", () => ({ requestFeishuAuthCode: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
describe("application entry identity refresh", () => {
  it("fetches fresh Feishu identity on every entry even when a local session exists", async () => {
    vi.mocked(readAuthBootstrap).mockResolvedValue({ authMode: "feishu", feishuAppId: "cli_test" });
    vi.mocked(requestFeishuAuthCode)
      .mockResolvedValueOnce("code-first")
      .mockResolvedValueOnce("code-reopened");
    await restoreOrCreateSession();
    await restoreOrCreateSession();
    expect(loginFeishu).toHaveBeenNthCalledWith(1, "code-first");
    expect(loginFeishu).toHaveBeenNthCalledWith(2, "code-reopened");
    expect(readSession).not.toHaveBeenCalled();
    expect(loginDevelopment).not.toHaveBeenCalled();
  });
  it("keeps development session restoration", async () => {
    vi.mocked(readAuthBootstrap).mockResolvedValue({ authMode: "development", feishuAppId: null });
    await restoreOrCreateSession();
    expect(readSession).toHaveBeenCalledOnce();
    expect(requestFeishuAuthCode).not.toHaveBeenCalled();
  });
});
