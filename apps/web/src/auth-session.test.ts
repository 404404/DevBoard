import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, loginDevelopment, loginFeishu, readAuthBootstrap, readSession } from "./api";
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
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("navigator", { userAgent: "Feishu" });
});
describe("application entry identity refresh", () => {
  it("fetches fresh Feishu identity on every entry even when a local session exists", async () => {
    vi.mocked(readAuthBootstrap).mockResolvedValue({
      authMode: "feishu",
      feishuAppId: "cli_test",
      webLoginEnabled: false,
    });
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

it("restores a Web session in a browser without requesting Feishu authorization", async () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });
  vi.mocked(readAuthBootstrap).mockResolvedValue({
    authMode: "feishu",
    feishuAppId: "cli_test",
    webLoginEnabled: true,
  });
  const session = {
    actor: {
      identity: { kind: "web", accountId: "00000000-0000-4000-8000-000000000005" },
      name: "Web user",
      avatarUrl: null,
      role: "member",
    },
    csrfToken: "x".repeat(32),
    expiresAt: "2030-01-01T00:00:00Z",
  } as const;
  vi.mocked(readSession).mockResolvedValue(session);
  expect(await restoreOrCreateSession()).toEqual(session);
  expect(requestFeishuAuthCode).not.toHaveBeenCalled();
  expect(loginDevelopment).not.toHaveBeenCalled();
});

it("Web-only mode requests an account even inside Feishu, never development login", async () => {
  vi.mocked(readAuthBootstrap).mockResolvedValue({
    authMode: "web",
    feishuAppId: null,
    webLoginEnabled: true,
  });
  vi.mocked(readSession).mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "需要登录"));
  await expect(restoreOrCreateSession()).rejects.toMatchObject({ enabled: true });
  expect(requestFeishuAuthCode).not.toHaveBeenCalled();
  expect(loginFeishu).not.toHaveBeenCalled();
  expect(loginDevelopment).not.toHaveBeenCalled();
});
