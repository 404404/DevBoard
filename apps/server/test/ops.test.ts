import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CORE_MIGRATIONS, initializeDatabase } from "../src/modules/database/index.js";
import { acquireDataDirectoryLock } from "../src/modules/operations/index.js";
import { runOperations } from "../src/ops.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operations CLI", () => {
  it("creates and verifies a backup with stable JSON output", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "codexboard-ops-"));
    temporaryDirectories.push(dataDirectory);
    initializeDatabase(join(dataDirectory, "taskboard.sqlite")).close();
    const destination = join(dataDirectory, "backups", "cli-backup");
    const lines: string[] = [];
    const environment = {
      CODEXBOARD_ENV: "test",
      CODEXBOARD_DATA_DIR: dataDirectory,
      CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
    };

    expect(
      await runOperations(["backup", "--output", destination], environment, (line) =>
        lines.push(line),
      ),
    ).toBe(0);
    expect(
      await runOperations(["verify", destination], environment, (line) => lines.push(line)),
    ).toBe(0);
    expect(lines.map((line) => JSON.parse(line) as { ok: boolean })).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  it("audits only verified backups without changing their database bytes", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "taskboard-identity-audit-"));
    temporaryDirectories.push(dataDirectory);
    const database = initializeDatabase(join(dataDirectory, "taskboard.sqlite"));
    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
      )
      .run(
        JSON.stringify(["feishu", "tenant", "registered"]),
        "tenant",
        "registered",
        "预登记成员",
        "member",
      );
    database.close();
    const destination = join(dataDirectory, "backups", "audit");
    const environment = {
      CODEXBOARD_ENV: "test",
      CODEXBOARD_DATA_DIR: dataDirectory,
      CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
    };
    expect(await runOperations(["backup", "--output", destination], environment, () => {})).toBe(0);
    const snapshot = join(destination, "taskboard.sqlite");
    const before = readFileSync(snapshot);
    const lines: string[] = [];
    expect(
      await runOperations(["audit-identities", destination], {}, (line) => lines.push(line)),
    ).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: true,
      data: {
        identities: [expect.objectContaining({ name: "预登记成员", identityKind: "unverified" })],
      },
    });
    expect(readFileSync(snapshot)).toEqual(before);
    writeFileSync(snapshot, "corrupt");
    expect(await runOperations(["audit-identities", destination], {}, () => {})).toBe(1);
  });

  it("returns usage exit code for an unknown command", async () => {
    const lines: string[] = [];
    expect(await runOperations(["unknown"], {}, (line) => lines.push(line))).toBe(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ ok: false, code: "USAGE_ERROR" });
  });

  it("refuses an offline CLI backup while restore owns the data-directory lock", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "codexboard-ops-locked-"));
    temporaryDirectories.push(dataDirectory);
    initializeDatabase(join(dataDirectory, "taskboard.sqlite")).close();
    const lock = acquireDataDirectoryLock(dataDirectory, "restore-test");
    const lines: string[] = [];
    try {
      expect(
        await runOperations(
          ["backup"],
          {
            CODEXBOARD_ENV: "test",
            CODEXBOARD_DATA_DIR: dataDirectory,
            CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
          },
          (line) => lines.push(line),
        ),
      ).toBe(1);
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        ok: false,
        code: "OPERATIONS_FAILED",
      });
      expect(lines[0]).toContain("数据目录正在使用");
    } finally {
      lock.release();
    }
  });

  it.each([47824, 80])(
    "routes backup through the protected local API on port %s while the service is running",
    async (adminPort) => {
      const dataDirectory = mkdtempSync(join(tmpdir(), "codexboard-ops-online-"));
      temporaryDirectories.push(dataDirectory);
      mkdirSync(join(dataDirectory, "run"));
      writeFileSync(
        join(dataDirectory, "run", "runtime.json"),
        `${JSON.stringify({
          descriptorVersion: 1,
          pid: process.pid,
          generatedAt: "2026-08-31T00:00:00.000Z",
          publicBaseUrl: "http://127.0.0.1:47823",
          localAdminBaseUrl: `http://127.0.0.1:${adminPort}`,
          capabilityToken: "x".repeat(43),
        })}\n`,
        { mode: 0o600 },
      );
      const lines: string[] = [];
      let request: { url?: string; authorization?: string | undefined } = {};

      expect(
        await runOperations(
          ["backup"],
          {
            CODEXBOARD_ENV: "test",
            CODEXBOARD_DATA_DIR: dataDirectory,
            CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
            CODEXBOARD_ADMIN_PORT: String(adminPort),
          },
          (line) => lines.push(line),
          {
            fetch: async (input, init) => {
              request = {
                url: String(input),
                authorization: new Headers(init?.headers).get("authorization") ?? undefined,
              };
              return new Response(
                JSON.stringify({
                  data: {
                    backupId: "backup-2026-test",
                    manifest: {
                      manifestVersion: 1,
                      createdAt: "2026-08-31T00:00:00.000Z",
                      schemaVersion: 5,
                      database: {
                        path: "taskboard.sqlite",
                        size: 1,
                        sha256: "0".repeat(64),
                      },
                      attachments: [],
                    },
                  },
                }),
                { status: 201, headers: { "content-type": "application/json" } },
              );
            },
          },
        ),
      ).toBe(0);
      expect(request).toEqual({
        url:
          adminPort === 80
            ? "http://127.0.0.1/api/v1/local/backups"
            : "http://127.0.0.1:47824/api/v1/local/backups",
        authorization: `Bearer ${"x".repeat(43)}`,
      });
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        ok: true,
        mode: "online",
        backupId: "backup-2026-test",
        directory: join(dataDirectory, "backups", "backup-2026-test"),
      });
    },
  );

  it.each([
    "http://127.0.0.1:81",
    "http://localhost:80",
    "http://192.168.1.1:80",
    "https://127.0.0.1:80",
    "http://user:secret@127.0.0.1:80",
    "http://127.0.0.1:80/path",
    "http://127.0.0.1:80/?q=1",
    "http://127.0.0.1:80/#fragment",
  ])("rejects a noncanonical admin runtime address %s", async (localAdminBaseUrl) => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "codexboard-ops-admin-url-"));
    temporaryDirectories.push(dataDirectory);
    mkdirSync(join(dataDirectory, "run"));
    writeFileSync(
      join(dataDirectory, "run", "runtime.json"),
      JSON.stringify({
        descriptorVersion: 1,
        pid: process.pid,
        generatedAt: "2026-08-31T00:00:00.000Z",
        publicBaseUrl: "http://127.0.0.1:47823",
        localAdminBaseUrl,
        capabilityToken: "x".repeat(43),
      }),
      { mode: 0o600 },
    );
    const lines: string[] = [];
    expect(
      await runOperations(
        ["backup"],
        {
          CODEXBOARD_ENV: "test",
          CODEXBOARD_DATA_DIR: dataDirectory,
          CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
          CODEXBOARD_ADMIN_PORT: "80",
        },
        (line) => lines.push(line),
        {
          fetch: async () => {
            throw new TypeError("offline test endpoint");
          },
        },
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("运行时管理地址与本机配置不一致");
  });

  it("falls back to the kernel lock when a stale runtime descriptor is unreachable", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "codexboard-ops-stale-runtime-"));
    temporaryDirectories.push(dataDirectory);
    initializeDatabase(join(dataDirectory, "taskboard.sqlite")).close();
    mkdirSync(join(dataDirectory, "run"), { recursive: true });
    writeFileSync(
      join(dataDirectory, "run", "runtime.json"),
      `${JSON.stringify({
        descriptorVersion: 1,
        pid: 2_147_483_647,
        generatedAt: "2026-08-31T00:00:00.000Z",
        publicBaseUrl: "http://127.0.0.1:47823",
        localAdminBaseUrl: "http://127.0.0.1:47824",
        capabilityToken: "x".repeat(43),
      })}\n`,
      { mode: 0o600 },
    );
    const lines: string[] = [];

    expect(
      await runOperations(
        ["backup"],
        {
          CODEXBOARD_ENV: "test",
          CODEXBOARD_DATA_DIR: dataDirectory,
          CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
        },
        (line) => lines.push(line),
        { fetch: async () => Promise.reject(new TypeError("connection refused")) },
      ),
    ).toBe(0);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: true,
      command: "backup",
      schemaVersion: CORE_MIGRATIONS.at(-1)!.version,
    });
  });
});
