import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { ProjectSnapshotWatcher, ProjectSyncService } from "../src/modules/project-sync/index.js";

const openDatabases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProjectSnapshotWatcher", () => {
  it("coalesces refreshes, keeps valid state on errors and closes its resources", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-project-watcher-"));
    temporaryDirectories.push(directory);
    const snapshotFile = join(directory, "codex-projects.json");
    const database = initializeDatabase(":memory:");
    openDatabases.push(database);
    const service = new ProjectSyncService({ database });
    let notifyChange: (() => void) | undefined;
    let watcherClosed = false;
    const watcher = new ProjectSnapshotWatcher({
      snapshotFile,
      service,
      debounceMs: 5,
      reconcileMs: 60_000,
      watchFactory: (_directory, listener) => {
        notifyChange = () => listener("rename", "codex-projects.json");
        return {
          close() {
            watcherClosed = true;
          },
          on() {},
        };
      },
    });
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

    await watcher.start();
    expect(service.status()).toMatchObject({ status: "synced", projectCount: 1 });
    const first = watcher.refresh();
    const second = watcher.refresh();
    expect(first).toBe(second);
    await first;

    writeFileSync(snapshotFile, '{"schemaVersion":1');
    notifyChange?.();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(service.status()).toMatchObject({ status: "stale", projectCount: 1 });

    writeFileSync(
      snapshotFile,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-09-01T12:01:00.000Z",
        projects: [],
      })}\n`,
    );
    await watcher.refresh();
    expect(service.status()).toMatchObject({ status: "synced", projectCount: 0 });

    await watcher.close();
    expect(watcherClosed).toBe(true);
  });
});
