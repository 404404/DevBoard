import { spawnSync, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDirectory = mkdtempSync(join(tmpdir(), "lark-taskboard-e2e-"));
const temporaryProjectRoot = join(dataDirectory, "temporary-project-root");
mkdirSync(temporaryProjectRoot);
const fakeCodexCommand = resolve("scripts/fake-codex-app-server.mjs");

async function allocateLoopbackPorts(count) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const reservation = createServer();
      await new Promise((resolveListen, rejectListen) => {
        reservation.once("error", rejectListen);
        reservation.listen(0, "127.0.0.1", resolveListen);
      });
      reservations.push(reservation);
    }
    return reservations.map((reservation) => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        throw new Error("无法分配 E2E 回环端口");
      }
      return address.port;
    });
  } finally {
    await Promise.all(
      reservations.map(
        (reservation) =>
          new Promise((resolveClose) => reservation.close(() => resolveClose(undefined))),
      ),
    );
  }
}

const [publicPort, adminPort, webPort] = await allocateLoopbackPorts(3);

const fakeCodexHome = join(dataDirectory, "codex-home");
const desktop = fork(resolve("scripts/fake-codex-desktop.mjs"), [], {
  env: { ...process.env, FAKE_CODEX_HOME: fakeCodexHome, FAKE_CODEX_INTERRUPT_DELAY_MS: "1500" },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
try {
  await new Promise((resolveReady, rejectReady) => {
    desktop.once("message", resolveReady);
    desktop.once("error", rejectReady);
    desktop.once("exit", () => rejectReady(new Error("Fake Desktop exited before ready")));
  });
  const result = spawnSync(
    process.execPath,
    [resolve("node_modules/@playwright/test/cli.js"), "test", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        FAKE_CODEX_HOME: fakeCodexHome,
        LARK_TASKBOARD_DATA_DIR: dataDirectory,
        LARK_TASKBOARD_TEMPORARY_PROJECT_ROOT: temporaryProjectRoot,
        LARK_TASKBOARD_WORKSPACE_ROOTS: dataDirectory,
        LARK_TASKBOARD_CODEX_COMMAND: fakeCodexCommand,
        LARK_TASKBOARD_PORT: String(publicPort),
        LARK_TASKBOARD_ADMIN_PORT: String(adminPort),
        LARK_TASKBOARD_ALLOWED_HOSTS: `127.0.0.1:${publicPort},localhost:${publicPort}`,
        LARK_TASKBOARD_ORIGIN: `http://127.0.0.1:${webPort}`,
        LARK_TASKBOARD_WEB_PORT: String(webPort),
        LARK_TASKBOARD_WEB_API_TARGET: `http://127.0.0.1:${publicPort}`,
        FAKE_CODEX_INTERRUPT_DELAY_MS: "1500",
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  const exited = new Promise((resolveExit) => desktop.once("exit", resolveExit));
  desktop.kill("SIGTERM");
  if (desktop.exitCode === null) await exited;
  rmSync(dataDirectory, { recursive: true, force: true });
}
