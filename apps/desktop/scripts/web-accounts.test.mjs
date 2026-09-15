import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manageWebAccounts } from "./web-accounts.mjs";

test("desktop account manager sends credentials only to the protected loopback API and refuses redirects", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-manager-test-"));
  try {
    await mkdir(join(root, "run"));
    const file = join(root, "run/runtime.json");
    await writeFile(
      file,
      JSON.stringify({
        localAdminBaseUrl: "http://127.0.0.1:47824",
        capabilityToken: "test-only-capability",
      }),
    );
    let calls = 0;
    const fetcher = async (url, options) => {
      calls++;
      assert.equal(url.href, "http://127.0.0.1:47824/api/v1/local/web-accounts");
      assert.equal(options.headers.Authorization, "Bearer test-only-capability");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "POST");
      assert.equal(JSON.parse(options.body).password, "a-test-password-long-enough");
      return { ok: true, json: async () => ({ data: { id: "test-account" } }) };
    };
    assert.deepEqual(
      await manageWebAccounts(
        root,
        "create",
        { username: "alice", name: "Alice", password: "a-test-password-long-enough" },
        fetcher,
      ),
      { id: "test-account" },
    );
    await writeFile(
      file,
      JSON.stringify({
        localAdminBaseUrl: "https://evil.example",
        capabilityToken: "test-only-capability",
      }),
    );
    await assert.rejects(manageWebAccounts(root, "list", {}, fetcher), /本机服务地址无效/);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
