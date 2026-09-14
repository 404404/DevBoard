import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { FeishuJsapiService } from "../src/modules/identity/feishu-jsapi-service.js";

const options = {
  appId: "cli_fixture",
  appSecret: "fixture-secret",
  apiBaseUrl: "https://open.feishu.cn",
  origin: "https://tasks.example.test",
};
function fixture() {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
      expect(JSON.parse(String(init?.body))).toEqual({
        app_id: options.appId,
        app_secret: options.appSecret,
      });
      return Response.json({ code: 0, tenant_access_token: "fixture-token", expire: 7200 });
    }
    expect(path).toBe("/open-apis/jssdk/ticket/get");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-token" });
    return Response.json({ code: 0, data: { ticket: "fixture-ticket", expire_in: 7200 } });
  });
  return { service: new FeishuJsapiService({ ...options, fetcher }), fetcher };
}
afterEach(() => vi.useRealTimers());
it("signs the exact page URL without hash, caches tickets and uses a fresh nonce for each signature", async () => {
  const { service, fetcher } = fixture();
  const url = "https://tasks.example.test/?remote=1&x=a%20b#thread";
  const configs = await Promise.all([service.config(url), service.config(url)]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const config of configs) {
    expect(config.signature).toBe(
      createHash("sha1")
        .update(
          `jsapi_ticket=fixture-ticket&noncestr=${config.nonceStr}&timestamp=${config.timestamp}&url=${url.split("#")[0]}`,
        )
        .digest("hex"),
    );
    expect(config.jsApiList).toEqual(["chooseMedia", "readFile"]);
    expect(JSON.stringify(config)).not.toMatch(/fixture-(secret|token|ticket)/);
  }
  expect(configs[0]!.nonceStr).not.toBe(configs[1]!.nonceStr);
});
it("refuses external origins and credentials before any remote request", async () => {
  const { service, fetcher } = fixture();
  for (const url of [
    "https://evil.test/",
    "https://tasks.example.test.evil.test/",
    "https://user@tasks.example.test/",
    "http://tasks.example.test/",
    "javascript:alert(1)",
  ]) {
    await expect(service.config(url)).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it("renews expired tickets and can recover after a failed retrieval without leaking upstream errors", async () => {
  vi.useFakeTimers();
  const { service, fetcher } = fixture();
  fetcher.mockRejectedValueOnce(new Error("secret-upstream-response"));
  await expect(service.config(options.origin)).rejects.toThrow("飞书相册功能暂时不可用，请重试");
  await service.config(options.origin);
  expect(fetcher).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.now() + 7200_000);
  await service.config(options.origin);
  expect(fetcher).toHaveBeenCalledTimes(5);
});
