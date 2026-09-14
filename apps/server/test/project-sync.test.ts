import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  ALL_PROJECT_ID,
  ProjectSyncService,
  TEMPORARY_PROJECT_ID,
  type CodexProjectSnapshot,
} from "../src/modules/project-sync/index.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";

const openDatabases: SqliteDatabase[] = [];
const CODEX_A = "11111111-1111-4111-8111-111111111111";
const CODEX_B = "22222222-2222-4222-8222-222222222222";
const CODEX_A_RECREATED = "33333333-3333-4333-8333-333333333333";

function snapshot(
  projects: CodexProjectSnapshot["projects"],
  generatedAt = "2026-09-01T12:00:00.000Z",
): CodexProjectSnapshot {
  return { schemaVersion: 1, generatedAt, projects };
}

function project(
  codexProjectId: string,
  name: string,
  rootPaths: string[],
  position: number,
): CodexProjectSnapshot["projects"][number] {
  return { codexProjectId, name, rootPaths, position };
}

function setup() {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const revisions: number[] = [];
  const service = new ProjectSyncService({
    database,
    now: () => new Date("2026-09-01T12:00:01.000Z"),
    onRevisionCommitted: (revision) => revisions.push(revision),
  });
  return { database, service, revisions };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe("ProjectSyncService", () => {
  it("creates, updates and reorders Codex mirrors idempotently", () => {
    const { database, service, revisions } = setup();
    const first = snapshot([
      project(CODEX_A, "论文", ["/Users/test/Projects/codex-paper"], 0),
      project(CODEX_B, "Docker", ["/Users/test/Docker", "/Users/test/Docker/tools"], 1),
    ]);

    expect(service.reconcile(first)).toMatchObject({
      created: 2,
      updated: 0,
      deleted: 0,
      restored: 0,
    });
    expect(
      database
        .prepare(
          `SELECT codex_project_id AS codexProjectId, project_key AS projectKey,
            name, workspace_realpath AS workspaceRealpath,
            root_paths_json AS rootPathsJson, sync_position AS syncPosition
          FROM projects WHERE source_kind = 'codex' ORDER BY sync_position`,
        )
        .all(),
    ).toEqual([
      {
        codexProjectId: CODEX_A,
        projectKey: "COFC",
        name: "论文",
        workspaceRealpath: "/Users/test/Projects/codex-paper",
        rootPathsJson: '["/Users/test/Projects/codex-paper"]',
        syncPosition: 0,
      },
      {
        codexProjectId: CODEX_B,
        projectKey: "DOVO",
        name: "Docker",
        workspaceRealpath: "/Users/test/Docker",
        rootPathsJson: '["/Users/test/Docker","/Users/test/Docker/tools"]',
        syncPosition: 1,
      },
    ]);

    expect(service.reconcile(first)).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(revisions).toHaveLength(1);

    expect(
      service.reconcile(
        snapshot(
          [
            project(CODEX_B, "Docker Desktop", ["/Users/test/Docker-Renamed"], 0),
            project(CODEX_A, "论文", ["/Users/test/Projects/codex-paper"], 1),
          ],
          "2026-09-01T12:01:00.000Z",
        ),
      ),
    ).toMatchObject({ created: 0, updated: 2, deleted: 0 });
    expect(service.status()).toMatchObject({
      status: "synced",
      projectCount: 2,
      snapshotGeneratedAt: "2026-09-01T12:01:00.000Z",
      lastErrorCode: null,
    });
    expect(
      database
        .prepare("SELECT project_key FROM projects WHERE codex_project_id = ?")
        .pluck()
        .get(CODEX_B),
    ).toBe("DOVO");
  });

  it("moves deleted project history to temporary and restores only the same Codex id", () => {
    const { database, service } = setup();
    service.reconcile(
      snapshot([
        project(CODEX_A, "论文", ["/Users/test/Projects/codex-paper"], 0),
        project(CODEX_B, "Docker", ["/Users/test/Docker"], 1),
      ]),
    );
    const sourceA = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .pluck()
      .get(CODEX_A) as string;
    const sourceB = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .pluck()
      .get(CODEX_B) as string;
    const taskA1 = randomUUID();
    const taskA2 = randomUUID();
    const taskB1 = randomUUID();
    const relationId = randomUUID();
    const commentId = randomUUID();
    const threadId = randomUUID();
    const jobId = randomUUID();
    const insertTask = database.prepare(
      `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
      VALUES (?, ?, ?, ?, ?, 'todo')`,
    );
    insertTask.run(taskA1, "PAPER-1", sourceA, 1, "论文任务一");
    insertTask.run(taskA2, "PAPER-2", sourceA, 2, "论文任务二");
    insertTask.run(taskB1, "DOCKER-1", sourceB, 1, "Docker 任务一");
    database
      .prepare(
        `INSERT INTO task_relations (id, project_id, type, source_task_id, target_task_id)
        VALUES (?, ?, 'related', ?, ?)`,
      )
      .run(relationId, sourceA, taskA1, taskA2);
    database
      .prepare("INSERT INTO comments (id, task_id, body) VALUES (?, ?, ?)")
      .run(commentId, taskA1, "历史评论");
    database
      .prepare(
        `INSERT INTO attachments (
          id, task_id, comment_id, filename, content_type, size_bytes, sha256, storage_key
        ) VALUES (?, ?, ?, 'evidence.txt', 'text/plain', 1, ?, ?)`,
      )
      .run(randomUUID(), taskA1, commentId, "a".repeat(64), "attachments/evidence.txt");
    database
      .prepare(
        `INSERT INTO task_threads (id, task_id, thread_id, cwd, is_primary)
        VALUES (?, ?, ?, ?, 1)`,
      )
      .run(threadId, taskA1, "thread-paper", "/Users/test/Projects/codex-paper");
    database
      .prepare(
        `INSERT INTO jobs (
          id, task_id, task_thread_id, kind, status, execution_key, idempotency_key
        ) VALUES (?, ?, ?, 'start', 'succeeded', ?, ?)`,
      )
      .run(jobId, taskA1, threadId, "/Users/test/Projects/codex-paper", "sync-job-key");

    expect(
      service.reconcile(
        snapshot(
          [project(CODEX_B, "Docker", ["/Users/test/Docker"], 0)],
          "2026-09-01T12:02:00.000Z",
        ),
      ),
    ).toMatchObject({ deleted: 1 });
    expect(
      database
        .prepare(
          "SELECT project_id AS projectId, task_number AS taskNumber FROM tasks WHERE id = ?",
        )
        .get(taskA1),
    ).toEqual({ projectId: TEMPORARY_PROJECT_ID, taskNumber: 1 });
    expect(
      database
        .prepare("SELECT project_id FROM task_relations WHERE id = ?")
        .pluck()
        .get(relationId),
    ).toBe(TEMPORARY_PROJECT_ID);
    expect(database.prepare("SELECT count(*) FROM project_orphaned_tasks").pluck().get()).toBe(2);
    for (const [table, id] of [
      ["comments", commentId],
      ["task_threads", threadId],
      ["jobs", jobId],
    ]) {
      expect(database.prepare(`SELECT count(*) FROM ${table} WHERE id = ?`).pluck().get(id)).toBe(
        1,
      );
    }

    expect(
      service.reconcile(
        snapshot(
          [
            project(CODEX_A, "论文", ["/Users/test/Projects/codex-paper"], 0),
            project(CODEX_B, "Docker", ["/Users/test/Docker"], 1),
          ],
          "2026-09-01T12:03:00.000Z",
        ),
      ),
    ).toMatchObject({ restored: 1 });
    expect(
      database
        .prepare(
          "SELECT project_id AS projectId, task_number AS taskNumber FROM tasks WHERE id = ?",
        )
        .get(taskA2),
    ).toEqual({ projectId: sourceA, taskNumber: 2 });
    expect(database.prepare("SELECT count(*) FROM project_orphaned_tasks").pluck().get()).toBe(0);

    service.reconcile(
      snapshot([project(CODEX_B, "Docker", ["/Users/test/Docker"], 0)], "2026-09-01T12:04:00.000Z"),
    );
    expect(
      service.reconcile(
        snapshot(
          [
            project(CODEX_A_RECREATED, "论文（重新添加）", ["/Users/test/Projects/codex-paper"], 0),
            project(CODEX_B, "Docker", ["/Users/test/Docker"], 1),
          ],
          "2026-09-01T12:05:00.000Z",
        ),
      ),
    ).toMatchObject({ created: 1, restored: 0 });
    expect(database.prepare("SELECT project_id FROM tasks WHERE id = ?").pluck().get(taskA1)).toBe(
      TEMPORARY_PROJECT_ID,
    );
    expect(
      database
        .prepare("SELECT count(*) FROM projects WHERE workspace_realpath = ?")
        .pluck()
        .get("/Users/test/Projects/codex-paper"),
    ).toBe(1);
    expect(
      database.prepare("SELECT count(*) FROM projects WHERE id = ?").pluck().get(ALL_PROJECT_ID),
    ).toBe(1);
    expect(
      database
        .prepare(
          "SELECT codex_project_id AS codexProjectId, project_key AS projectKey FROM projects WHERE codex_project_id IN (?, ?) ORDER BY codex_project_id",
        )
        .all(CODEX_A, CODEX_A_RECREATED),
    ).toEqual([
      { codexProjectId: CODEX_A, projectKey: "COFC" },
      { codexProjectId: CODEX_A_RECREATED, projectKey: "COLFC" },
    ]);
  });

  it("uses a stable five-letter key when two new roots share a four-letter candidate", () => {
    const { database, service } = setup();

    service.reconcile(
      snapshot([
        project(CODEX_A, "项目十五", ["/Users/test/project-15"], 0),
        project(CODEX_B, "项目二十六", ["/Users/test/project-26"], 1),
      ]),
    );

    expect(
      database
        .prepare(
          "SELECT project_key FROM projects WHERE source_kind = 'codex' ORDER BY sync_position",
        )
        .pluck()
        .all(),
    ).toEqual(["PRLP", "PRYLP"]);
  });

  it("marks failures stale without interpreting them as an empty snapshot", () => {
    const { database, service } = setup();
    service.reconcile(
      snapshot([project(CODEX_A, "论文", ["/Users/test/Projects/codex-paper"], 0)]),
    );

    service.recordFailure("PROJECT_SNAPSHOT_INVALID");

    expect(service.status()).toMatchObject({
      status: "stale",
      projectCount: 1,
      lastErrorCode: "PROJECT_SNAPSHOT_INVALID",
    });
    expect(
      database
        .prepare(
          "SELECT count(*) FROM projects WHERE source_kind = 'codex' AND sync_deleted_at IS NULL",
        )
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("renumbers duplicate source task numbers when multiple projects are deleted together", () => {
    const { database, service } = setup();
    service.reconcile(
      snapshot([
        project(CODEX_A, "论文", ["/Users/test/Projects/codex-paper"], 0),
        project(CODEX_B, "Docker", ["/Users/test/Docker"], 1),
      ]),
    );
    const projects = database
      .prepare(
        "SELECT id, codex_project_id AS codexProjectId FROM projects WHERE source_kind = 'codex'",
      )
      .all() as { id: string; codexProjectId: string }[];
    for (const source of projects) {
      database
        .prepare(
          `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
          VALUES (?, ?, ?, 1, ?, 'todo')`,
        )
        .run(randomUUID(), `TASK-${source.codexProjectId.slice(0, 4)}`, source.id, "同序号任务");
    }

    expect(service.reconcile(snapshot([], "2026-09-01T12:10:00.000Z"))).toMatchObject({
      deleted: 2,
    });
    expect(
      database
        .prepare("SELECT task_number FROM tasks WHERE project_id = ? ORDER BY task_number")
        .pluck()
        .all(TEMPORARY_PROJECT_ID),
    ).toEqual([1, 2]);
    expect(database.prepare("SELECT count(*) FROM project_orphaned_tasks").pluck().get()).toBe(2);
  });

  it("adopts an unbound legacy project once by its primary root", () => {
    const { database, service } = setup();
    const legacyId = randomUUID();
    database
      .prepare(
        `INSERT INTO projects (id, project_key, name, workspace_realpath)
        VALUES (?, 'LEGACY', '旧项目', '/Users/test/Legacy')`,
      )
      .run(legacyId);
    const legacyTaskId = randomUUID();
    database
      .prepare(
        `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
        VALUES (?, 'LEGACY-1', ?, 1, '旧任务', 'todo')`,
      )
      .run(legacyTaskId, legacyId);

    expect(
      service.reconcile(snapshot([project(CODEX_A, "已接管", ["/Users/test/Legacy"], 0)])),
    ).toMatchObject({ created: 0, updated: 1 });
    expect(
      database
        .prepare(
          "SELECT id, project_key AS projectKey, source_kind AS sourceKind, codex_project_id AS codexProjectId FROM projects WHERE workspace_realpath = ?",
        )
        .get("/Users/test/Legacy"),
    ).toEqual({ id: legacyId, projectKey: "LEQA", sourceKind: "codex", codexProjectId: CODEX_A });
    expect(
      database.prepare("SELECT identifier FROM tasks WHERE id = ?").pluck().get(legacyTaskId),
    ).toBe("LEQA-001");
  });
});
