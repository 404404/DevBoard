import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("accepts legacy settings while new values and explicit emptiness take priority", () => {
    expect(loadConfig({ LARK_CODEX_PORT: "48123" }).CODEXBOARD_PORT).toBe(48123);
    expect(loadConfig({ LARK_CODEX_PORT: "48123", CODEXBOARD_PORT: "48125" }).CODEXBOARD_PORT).toBe(
      48125,
    );
    expect(() => loadConfig({ LARK_CODEX_DATA_DIR: "/old/data", CODEXBOARD_DATA_DIR: "" })).toThrow(
      ConfigError,
    );
  });
  it("uses a Docker-publishable public listener and loopback admin listener by default", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      CODEXBOARD_HOST: "0.0.0.0",
      CODEXBOARD_PORT: 47_823,
      CODEXBOARD_ADMIN_HOST: "127.0.0.1",
      CODEXBOARD_ADMIN_PORT: 47_824,
      CODEXBOARD_ORIGIN: "http://localhost:5173",
      CODEXBOARD_SSH_IDENTITY_DIR: "/run/devboard/ssh/identities",
      CODEXBOARD_EVENT_HISTORY_LIMIT: 10_000,
      CODEXBOARD_SSE_HEARTBEAT_MS: 15_000,
      CODEXBOARD_SSE_RETRY_MS: 3_000,
      CODEXBOARD_SSE_WRITE_TIMEOUT_MS: 10_000,
      CODEXBOARD_PROJECT_SYNC_RECONCILE_MS: 30_000,
    });
    expect(config.CODEXBOARD_DATA_DIR).toBe(
      join(fileURLToPath(new URL("../../../", import.meta.url)), ".data"),
    );
    expect(config.CODEXBOARD_WORKSPACE_ROOTS).toEqual([
      fileURLToPath(new URL("../../../", import.meta.url)),
    ]);
    expect(config.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE).toBe(
      join(config.CODEXBOARD_DATA_DIR, "run/codex-projects.json"),
    );
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ CODEXBOARD_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_ADMIN_PORT: "47823" })).toThrow(ConfigError);
  });

  it("accepts explicit proxy addresses and rejects wildcard proxy trust", () => {
    expect(
      loadConfig({ CODEXBOARD_TRUST_PROXY: "172.20.0.0/16,127.0.0.1" }).CODEXBOARD_TRUST_PROXY,
    ).toEqual(["172.20.0.0/16", "127.0.0.1"]);
    expect(() => loadConfig({ CODEXBOARD_TRUST_PROXY: "*" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_TRUST_PROXY: "0.0.0.0/0" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_TRUST_PROXY: "::/0" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_TRUST_PROXY: "proxy.local" })).toThrow(ConfigError);
  });

  it("accepts the published SSH Identity directory setting and rejects relative paths", () => {
    expect(
      loadConfig({ DEVBOARD_SSH_IDENTITY_DIR: "/run/devboard/ssh/identities" })
        .CODEXBOARD_SSH_IDENTITY_DIR,
    ).toBe("/run/devboard/ssh/identities");
    expect(() => loadConfig({ DEVBOARD_SSH_IDENTITY_DIR: "./secrets/identities" })).toThrow(
      ConfigError,
    );
  });

  it("requires an explicit HTTPS Public Origin in production", () => {
    expect(() => loadConfig({ CODEXBOARD_ENV: "production" })).toThrow(/PUBLIC_ORIGIN/);
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "production",
        DEVBOARD_PUBLIC_ORIGIN: "http://board.example.com",
      }),
    ).toThrow(/HTTPS/);
    const webRoot = mkdtempSync(join(tmpdir(), "devboard-web-root-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
    try {
      expect(
        loadConfig({
          CODEXBOARD_ENV: "production",
          CODEXBOARD_AUTH_MODE: "web",
          DEVBOARD_PUBLIC_ORIGIN: "https://board.example.com",
          CODEXBOARD_WEB_ROOT: webRoot,
        }).CODEXBOARD_ORIGIN,
      ).toBe("https://board.example.com");
    } finally {
      rmSync(webRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe event feed limits and timing values", () => {
    expect(() => loadConfig({ CODEXBOARD_EVENT_HISTORY_LIMIT: "9" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_SSE_HEARTBEAT_MS: "999" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_SSE_WRITE_TIMEOUT_MS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_PROJECT_SYNC_RECONCILE_MS: "49" })).toThrow(ConfigError);
  });

  it("requires absolute workspace roots", () => {
    expect(() => loadConfig({ CODEXBOARD_WORKSPACE_ROOTS: "relative/path" })).toThrow(ConfigError);
  });

  it("accepts an absolute temporary project display root without using it as a workspace root", () => {
    const displayRoot = join(tmpdir(), "codexboard-temporary-display-root");

    expect(loadConfig({ CODEXBOARD_TEMPORARY_PROJECT_ROOT: displayRoot })).toMatchObject({
      CODEXBOARD_TEMPORARY_PROJECT_ROOT: displayRoot,
    });
    expect(() =>
      loadConfig({ CODEXBOARD_TEMPORARY_PROJECT_ROOT: "relative/temporary-root" }),
    ).toThrow(ConfigError);
  });

  it.skipIf(process.platform !== "darwin")(
    "defaults temporary projects to the current user's Documents folder before it exists",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "codexboard-new-user-home-"));
      try {
        vi.stubEnv("HOME", directory);
        const expected = join(directory, "Documents", "Codex");
        expect(existsSync(expected)).toBe(false);
        expect(loadConfig({}).CODEXBOARD_TEMPORARY_PROJECT_ROOT).toBe(expected);
        expect(existsSync(expected)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("fails closed for unsafe authentication mode combinations", () => {
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "production",
        CODEXBOARD_AUTH_MODE: "development",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_ORIGIN: "http://localhost:5173",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "production",
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_HOST: "0.0.0.0",
        CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
        CODEXBOARD_FEISHU_APP_SECRET: "secret",
        CODEXBOARD_ORIGIN: "https://tasks.example.com",
        CODEXBOARD_WEB_ROOT: "/missing/devboard-web-root",
      }),
    ).toThrow(ConfigError);
  });

  it.each([
    ["http://8.8.8.8:47823", "http://8.8.8.8:47823"],
    ["http://8.8.8.8:80", "http://8.8.8.8"],
    ["http://8.8.8.8", "http://8.8.8.8"],
    ["http://tasks.example.com:8080", "http://tasks.example.com:8080"],
  ])(
    "allows Feishu authentication on a canonical public IPv4 HTTP origin: %s",
    (origin, normalizedOrigin) => {
      expect(
        loadConfig({
          CODEXBOARD_ENV: "test",
          CODEXBOARD_AUTH_MODE: "feishu",
          CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
          CODEXBOARD_FEISHU_APP_SECRET: "secret",
          CODEXBOARD_ORIGIN: origin,
          CODEXBOARD_ALLOWED_HOSTS: new URL(origin).host,
        }),
      ).toMatchObject({
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_ORIGIN: normalizedOrigin,
      });
    },
  );

  it.each([
    "http://0.1.2.3:47823",
    "http://10.0.0.1:47823",
    "http://100.64.0.1:47823",
    "http://127.0.0.1:47823",
    "http://127.0.0.0x1",
    "http://169.254.1.1:47823",
    "http://172.16.0.1:47823",
    "http://192.0.0.1:47823",
    "http://192.0.2.1:47823",
    "http://192.168.1.1:47823",
    "http://198.18.0.1:47823",
    "http://198.51.100.1:47823",
    "http://203.0.113.1:47823",
    "http://224.0.0.1:47823",
    "http://tasks.example.com:47823/path",
    "http://8.8.8.8:47823/path",
    "http://user@8.8.8.8:47823",
  ])("rejects a non-public or non-canonical Feishu HTTP origin: %s", (origin) => {
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "test",
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
        CODEXBOARD_FEISHU_APP_SECRET: "secret",
        CODEXBOARD_ORIGIN: origin,
      }),
    ).toThrow(ConfigError);
  });

  it("does not expose development authentication on a public HTTP origin", () => {
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "test",
        CODEXBOARD_AUTH_MODE: "development",
        CODEXBOARD_ORIGIN: "http://8.8.8.8:47823",
      }),
    ).toThrow(ConfigError);
  });

  it("ignores legacy local Codex bridge environment variables", () => {
    const config = loadConfig({
      CODEXBOARD_CODEX_TRANSPORT: "embedded",
      CODEXBOARD_CODEX_ENDPOINT: "ws://127.0.0.1:47825",
      CODEXBOARD_CODEX_TOKEN_FILE: "/legacy/codex-app-server-token",
    });
    expect(config).not.toHaveProperty("CODEXBOARD_CODEX_TRANSPORT");
    expect(config).not.toHaveProperty("CODEXBOARD_CODEX_ENDPOINT");
    expect(config).not.toHaveProperty("CODEXBOARD_CODEX_TOKEN_FILE");
  });

  it("requires a built web root and a private Feishu secret file in production", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-production-config-"));
    const webRoot = join(directory, "missing-web-root");
    const secretFile = join(directory, "feishu-secret");
    try {
      writeFileSync(secretFile, "secret-from-file\n", { mode: 0o600 });
      let error: unknown;
      try {
        loadConfig({
          CODEXBOARD_ENV: "production",
          CODEXBOARD_AUTH_MODE: "feishu",
          CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
          CODEXBOARD_FEISHU_APP_SECRET_FILE: secretFile,
          CODEXBOARD_ORIGIN: "https://tasks.example.com",
          CODEXBOARD_ALLOWED_HOSTS: "tasks.example.com",
          CODEXBOARD_WEB_ROOT: webRoot,
        });
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toContain(
        "CODEXBOARD_WEB_ROOT: Web 构建目录缺少 index.html",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("unified Feishu credentials configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-credentials-config-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, "feishu.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({ appId: "cli_credentials123", appSecret: "private-test-secret" }),
    { mode: 0o600 },
  );
  const legacySecretFile = join(directory, "legacy-secret");
  writeFileSync(legacySecretFile, "other-secret", { mode: 0o600 });

  it("loads both credentials from one private file in production Feishu mode", () => {
    const webRoot = join(directory, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<html></html>");
    const config = loadConfig({
      CODEXBOARD_ENV: "production",
      CODEXBOARD_AUTH_MODE: "feishu",
      CODEXBOARD_FEISHU_CREDENTIALS_FILE: credentialsFile,
      CODEXBOARD_ORIGIN: "https://tasks.example.com",
      CODEXBOARD_WEB_ROOT: webRoot,
    });

    expect(config.CODEXBOARD_FEISHU_APP_ID).toBe("cli_credentials123");
    expect(config.CODEXBOARD_FEISHU_APP_SECRET).toBe("private-test-secret");
    expect(config.CODEXBOARD_FEISHU_APP_SECRET_FILE).toBeUndefined();
  });

  it.each([
    ["CODEXBOARD_FEISHU_APP_ID", "cli_other"],
    ["CODEXBOARD_FEISHU_APP_SECRET", "other-secret"],
    ["CODEXBOARD_FEISHU_APP_SECRET_FILE", legacySecretFile],
  ])("rejects a credentials file mixed with %s", (key, value) => {
    expect(() =>
      loadConfig({
        CODEXBOARD_FEISHU_CREDENTIALS_FILE: credentialsFile,
        [key]: value,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects relative, missing, symlink and publicly readable credentials files", () => {
    const symlink = join(directory, "credentials-link");
    symlinkSync(credentialsFile, symlink);
    const publicFile = join(directory, "public.json");
    writeFileSync(publicFile, '{"appId":"cli_test","appSecret":"secret"}', { mode: 0o644 });

    for (const path of [
      "relative.json",
      join(directory, "missing.json"),
      symlink,
      publicFile,
      directory,
    ]) {
      expect(() => loadConfig({ CODEXBOARD_FEISHU_CREDENTIALS_FILE: path })).toThrow(ConfigError);
    }
  });

  it.each([
    '{"appSecret":"sensitive-parse-test",',
    JSON.stringify({ appId: "cli_test" }),
    JSON.stringify({ appId: "cli_test", appSecret: "" }),
    JSON.stringify({ appId: "cli_test", appSecret: 123 }),
    JSON.stringify({ appId: "invalid", appSecret: "sensitive-parse-test" }),
    JSON.stringify({ appId: "cli_test", appSecret: "secret\nline" }),
    "null",
  ])("rejects invalid credentials without echoing their contents (%#)", (contents) => {
    const path = join(directory, "invalid.json");
    writeFileSync(path, contents, { mode: 0o600 });
    let caught: unknown;
    try {
      loadConfig({ CODEXBOARD_FEISHU_CREDENTIALS_FILE: path });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(JSON.stringify((caught as ConfigError).issues)).not.toContain("sensitive-parse-test");
  });
});
