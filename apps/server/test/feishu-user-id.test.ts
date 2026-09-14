import { describe, expect, it } from "vitest";

import { FeishuIdentityAdapter } from "../src/modules/identity/adapters/feishu-identity-adapter.js";

function adapter(user: Record<string, unknown>) {
  return new FeishuIdentityAdapter({
    appId: "cli_fixture",
    appSecret: "fixture-secret",
    apiBaseUrl: "https://open.feishu.cn",
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/open-apis/auth/v3/app_access_token/internal") {
        return Response.json({ code: 0, app_access_token: "fixture-app-token", expire: 7200 });
      }
      if (path === "/open-apis/authen/v1/access_token") {
        return Response.json({ code: 0, data: { access_token: "fixture-user-token" } });
      }
      if (path === "/open-apis/authen/v1/user_info") {
        return Response.json({ code: 0, data: user });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
}

describe("Feishu enterprise user identity", () => {
  it("uses the enterprise user_id across applications instead of app-specific open_id", async () => {
    const first = await adapter({
      tenant_key: "tenant-a",
      open_id: "ou_app_one",
      user_id: "user-one",
      name: "Alice",
    }).exchangeCode("valid-code-one");
    const second = await adapter({
      tenant_key: "tenant-a",
      open_id: "ou_app_two",
      user_id: "user-one",
      name: "Alice",
    }).exchangeCode("valid-code-two");
    expect(first).toEqual({
      identity: { kind: "feishu", tenantKey: "tenant-a", userId: "user-one" },
      name: "Alice",
      avatarUrl: null,
    });
    expect(second).toEqual(first);
  });

  it("does not invent a user_id when the scope omits it", async () => {
    await expect(
      adapter({ tenant_key: "tenant-a", open_id: "ou_only", name: "Alice" }).exchangeCode(
        "valid-auth-code",
      ),
    ).rejects.toThrow(/user_id/);
  });

  it("rejects user information without a tenant", async () => {
    await expect(
      adapter({ user_id: "user-one", open_id: "ou_only", name: "Alice" }).exchangeCode(
        "valid-auth-code",
      ),
    ).rejects.toThrow();
  });
});
