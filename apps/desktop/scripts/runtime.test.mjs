import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv, nativeEnvironment, assertPortsFree, stopChildren } from "./runtime.mjs";
import net from "node:net";
test("configured ports reach the backend, admin listener and embedded bridge", () => {
  const result = nativeEnvironment({}, { LARK_CODEX_DATA_DIR: "/data" }, "/bundle", {
    api: 48023,
    admin: 48024,
    bridge: 48025,
    caddy: 9443,
  });
  assert.equal(result.LARK_CODEX_PORT, "48023");
  assert.equal(result.LARK_CODEX_ADMIN_PORT, "48024");
  assert.equal(result.LARK_CODEX_CODEX_ENDPOINT, "ws://127.0.0.1:48025");
});
test("dotenv parser preserves quoted spaces, never evaluates shell code", () => {
  assert.deepEqual(parseEnv('A="a b"\nB=$(echo secret)\n# hi\nC=plain'), {
    A: "a b",
    B: "$(echo secret)",
    C: "plain",
  });
});
test("native config replaces container paths without leaking inherited secrets", () => {
  const result = nativeEnvironment(
    {
      LARK_CODEX_ENV: "production",
      LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE: "/var/lib/lark-codex/run/codex-projects.json",
    },
    {
      LARK_CODEX_DATA_DIR: "/Users/example/data",
      LARK_CODEX_FEISHU_CREDENTIALS_FILE: "/secrets/feishu",
      LARK_CODEX_CODEX_TOKEN_FILE: "/secrets/codex",
    },
    "/app/runtime",
  );
  assert.equal(result.LARK_CODEX_CODEX_TRANSPORT, "embedded");
  assert.ok(result.LARK_CODEX_CODEX_PROJECT_STATE_FILE.endsWith(".codex/.codex-global-state.json"));
  assert.equal(result.LARK_CODEX_CODEX_ENDPOINT, "ws://127.0.0.1:58980");
  assert.equal(
    result.LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE,
    "/Users/example/data/run/codex-projects.json",
  );
  assert.equal(result.LARK_CODEX_WEB_ROOT, "/app/runtime/apps/web/dist");
  assert.equal(result.LARK_CODEX_FEISHU_CREDENTIALS_FILE, "/secrets/feishu");
});
test("occupied ports are rejected without stopping their owner", async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(assertPortsFree([s.address().port]), /占用/);
    assert.equal(s.listening, true);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

import { spawn } from "node:child_process";
test("native task execution uses bundled CLI instead of Docker", () => {
  const env = nativeEnvironment(
    { LARK_CODEX_EXECUTOR_TASKCTL_PATH: "/old/taskctl-docker.mjs" },
    { LARK_CODEX_DATA_DIR: "/data", LARK_CODEX_WORKSPACE_ROOT: "/project" },
    "/bundle",
  );
  assert.equal(env.LARK_CODEX_EXECUTOR_TASKCTL_PATH, "/bundle/packages/taskctl/dist/cli.js");
  assert.equal(env.LARK_CODEX_EXECUTOR_NODE_PATH, "/bundle/bin/node");
  assert.equal(env.LARK_CODEX_WORKSPACE_ROOTS, "/project");
});
test("stopping services waits for owned children and leaves unrelated processes alone", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await stopChildren([child], 200);
    assert.ok(child.signalCode || child.exitCode !== null);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
  } finally {
    await stopChildren([other], 200);
  }
});

test("shutdown allows cleanup and force-stops a child that ignores SIGTERM", async () => {
  const launch = async (script) => {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    return child;
  };
  const graceful = await launch(
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));setInterval(()=>{},1000);console.log('ready')",
  );
  await stopChildren([graceful], 1500);
  assert.equal(graceful.exitCode, 0);
  const stubborn = await launch(
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')",
  );
  await stopChildren([stubborn], 100);
  assert.equal(stubborn.signalCode, "SIGKILL");
});

import http from "node:http";
import { checkLocalApi } from "./runtime.mjs";
test("local health check sends the configured Host header", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.headers.host === "tasks.example.test" ? 200 : 400);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    assert.equal(await checkLocalApi(server.address().port, "tasks.example.test"), true);
    assert.equal(await checkLocalApi(server.address().port, "wrong.test"), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

import { openFeishuBoard } from "./runtime.mjs";
test("opens the configured app in Feishu without a browser URL override", async () => {
  let opened;
  await openFeishuBoard(
    { phase: "ready", appId: "cli_test123", origin: "https://tasks.example.test" },
    {
      checkPublic: async () => true,
      openNative: async (...args) => {
        opened = args;
      },
    },
  );
  assert.deepEqual(opened, [
    "com.electron.lark",
    "https://applink.feishu.cn/client/web_app/open?appId=cli_test123",
  ]);
});
test("incomplete deployment never launches an application", async () => {
  for (const input of [
    { phase: "stopped", appId: "cli_test123", origin: "https://tasks.example.test" },
    { phase: "ready", appId: "", origin: "https://tasks.example.test" },
    { phase: "ready", appId: "cli_test123", origin: "ftp://tasks.example.test" },
  ]) {
    await assert.rejects(
      openFeishuBoard(input, {
        checkPublic: async () => {
          throw new Error("must not check");
        },
        openNative: async () => {
          throw new Error("must not launch");
        },
      }),
      /未部署完成/,
    );
  }
});
test("unreachable deployment never launches Feishu", async () => {
  await assert.rejects(
    openFeishuBoard(
      { phase: "ready", appId: "cli_test123", origin: "https://tasks.example.test" },
      {
        checkPublic: async () => false,
        openNative: async () => {
          throw new Error("must not launch");
        },
      },
    ),
    /未部署完成/,
  );
});
test("missing Feishu client reports an actionable error without browser fallback", async () => {
  await assert.rejects(
    openFeishuBoard(
      { phase: "ready", appId: "cli_test123", origin: "https://tasks.example.test" },
      {
        checkPublic: async () => true,
        openNative: async () => {
          throw new Error("native failure");
        },
      },
    ),
    /无法打开飞书/,
  );
});

test("health checks use fresh connections across backend restarts", async () => {
  let connections = 0;
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("connection", () => connections++);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await checkLocalApi(server.address().port, "tasks.example.test");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await checkLocalApi(server.address().port, "tasks.example.test");
    assert.equal(connections, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("desktop owns internal settings even when legacy values are present", () => {
  const env = nativeEnvironment(
    {
      LARK_CODEX_ENV: "development",
      LARK_CODEX_AUTH_MODE: "development",
      LARK_CODEX_ORIGIN: "https://tasks.example.test",
      LARK_CODEX_ALLOWED_HOSTS: "stale.example.test",
      LARK_CODEX_HOST: "0.0.0.0",
      LARK_CODEX_PORT: "9000",
      LARK_CODEX_ADMIN_PORT: "9001",
      LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE: "/legacy/snapshot.json",
      LARK_CODEX_TEMPORARY_PROJECT_ROOT: "/old/user/location",
    },
    { LARK_CODEX_DATA_DIR: "/data" },
    "/bundle",
  );
  assert.equal(env.LARK_CODEX_ENV, "production");
  assert.equal(env.LARK_CODEX_AUTH_MODE, "feishu");
  assert.equal(env.LARK_CODEX_HOST, "127.0.0.1");
  assert.equal(env.LARK_CODEX_PORT, "58978");
  assert.equal(env.LARK_CODEX_ADMIN_PORT, "58979");
  assert.equal(env.LARK_CODEX_ALLOWED_HOSTS, "tasks.example.test");
  assert.equal(env.LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE, "/data/run/codex-projects.json");
  assert.equal(env.LARK_CODEX_TEMPORARY_PROJECT_ROOT, undefined);
});

test("HTTP proxy preserves public port and does not enable TLS", async () => {
  const { renderCaddyfile } = await import("./runtime.mjs");
  const content = renderCaddyfile(new URL("http://8.8.8.8:52480"), {
    api: 48823,
    caddy: 58981,
  });
  assert.match(content, /auto_https off/);
  assert.match(content, /http:\/\/8\.8\.8\.8:58981/);
  assert.match(content, /header_up Host 8\.8\.8\.8:52480/);
  assert.match(content, /header_up X-Forwarded-Proto http/);
  assert.doesNotMatch(content, /issuer acme/);
  const secure = renderCaddyfile(new URL("https://tasks.example.com"), {
    api: 48823,
    caddy: 58443,
  });
  assert.match(secure, /issuer acme/);
  assert.match(secure, /header_up X-Forwarded-Proto https/);
  assert.throws(() => renderCaddyfile(new URL("http://127.0.0.1:5000"), { api: 1, caddy: 2 }));
});

test("HTTP deployment opens the Feishu app after checking its public origin", async () => {
  let checked;
  let opened;
  await openFeishuBoard(
    { phase: "ready", appId: "cli_test123", origin: "http://8.8.8.8:52480" },
    {
      checkPublic: async (origin) => {
        checked = origin;
        return true;
      },
      openNative: async (...args) => {
        opened = args;
      },
    },
  );
  assert.equal(checked, "http://8.8.8.8:52480");
  assert.deepEqual(opened, [
    "com.electron.lark",
    "https://applink.feishu.cn/client/web_app/open?appId=cli_test123",
  ]);
});

test("Web native runtime does not require or forward a Feishu credentials file", () => {
  const env = nativeEnvironment(
    { LARK_CODEX_ORIGIN: "https://web.example.com", LARK_CODEX_AUTH_MODE: "web" },
    { LARK_CODEX_DATA_DIR: "/data", LARK_CODEX_FEISHU_CREDENTIALS_FILE: "/secrets/feishu.json" },
    "/runtime",
  );
  assert.equal(env.LARK_CODEX_AUTH_MODE, "web");
  assert.equal(env.LARK_CODEX_FEISHU_CREDENTIALS_FILE, undefined);
  assert.equal(env.LARK_CODEX_ENV, "production");
});
