import { ErrorEnvelopeSchema, HealthResponseSchema } from "@codexboard/contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appControl, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase } from "../src/modules/database/index.js";

const openApps: ReturnType<typeof createApp>[] = [];
const temporaryDirectories: string[] = [];

function createTestApp() {
  return createApp({
    config: loadConfig({ CODEXBOARD_ENV: "test" }),
    database: initializeDatabase(":memory:"),
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("HTTP application", () => {
  it("returns a contract-valid health response", async () => {
    const app = createTestApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:47823" },
    });
    const payload: unknown = response.json();

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(payload)).toMatchObject({
      status: "ok",
      service: "codexboard-server",
      checks: { http: "ok", sqlite: "ok" },
    });
  });

  it("uses the stable error envelope for missing routes", async () => {
    const app = createTestApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/missing",
      headers: { host: "127.0.0.1:47823" },
    });
    const payload: unknown = response.json();

    expect(response.statusCode).toBe(404);
    expect(ErrorEnvelopeSchema.parse(payload).error.code).toBe("NOT_FOUND");
  });

  it("starts project snapshot reconciliation with the app lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-app-project-sync-"));
    temporaryDirectories.push(directory);
    const snapshotFile = join(directory, "codex-projects.json");
    writeFileSync(
      snapshotFile,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-09-01T12:00:00.000Z",
        projects: [
          {
            codexProjectId: "11111111-1111-4111-8111-111111111111",
            name: "论文",
            rootPaths: ["/Users/test/Projects/codex-paper"],
            position: 0,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const app = createApp({
      config: loadConfig({
        CODEXBOARD_ENV: "test",
        CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE: snapshotFile,
      }),
      database: initializeDatabase(":memory:"),
    });
    openApps.push(app);

    await app.ready();

    expect(appControl(app).services.projectSync.status()).toMatchObject({
      status: "synced",
      projectCount: 1,
    });
  });
});
