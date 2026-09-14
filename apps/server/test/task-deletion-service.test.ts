import { identityKey } from "@lark-codex/contracts";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CreateCommentCommandSchema,
  CreateTaskCommandSchema,
  DeleteTaskCommandSchema,
  type PrincipalView,
} from "@lark-codex/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentVault } from "../src/modules/attachments/index.js";
import { CodexRequestError } from "../src/modules/codex/index.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import type { CodexThreadProvisioner } from "../src/modules/execution/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard, TaskDeletionService, TaskWorkspace } from "../src/modules/taskboard/index.js";

const ADMIN_ACTOR: PrincipalView = {
  identity: TEST_FEISHU_ACTOR.identity,
  name: "本机管理员",
  avatarUrl: null,
  role: "admin",
};
const openDatabases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

class RecordingProvisioner implements CodexThreadProvisioner {
  readonly archived: string[] = [];
  archiveError: Error | undefined;
  archiveStarted: (() => void) | undefined;
  archiveGate: Promise<void> | undefined;

  async createDraft() {
    return { threadId: "unused", cwd: "/unused" };
  }

  async archiveThread(threadId: string): Promise<void> {
    if (this.archiveError) throw this.archiveError;
    this.archived.push(threadId);
    this.archiveStarted?.();
    await this.archiveGate;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(status: "done" | "canceled" = "canceled") {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const root = mkdtempSync(join(tmpdir(), "lark-codex-delete-"));
  temporaryDirectories.push(root);
  const vault = new AttachmentVault({ rootDirectory: root });
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  seedFeishuTestActor(database, ADMIN_ACTOR);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "DEL",
    name: "删除测试",
    description: "",
  });
  const taskboard = new Taskboard({ database, identityService });
  const workspace = new TaskWorkspace({ database, identityService, taskboard });
  const created = taskboard.createTask(
    CreateTaskCommandSchema.parse({ projectId: project.id, title: "需要彻底删除" }),
    { actor: ADMIN_ACTOR, idempotencyKey: "create-delete-target" },
  ).task;
  const task = taskboard.moveTask(
    created.id,
    { expectedVersion: created.version, targetStatus: status },
    { actor: ADMIN_ACTOR, idempotencyKey: "cancel-delete-target" },
  ).task;
  const provisioner = new RecordingProvisioner();
  const revisions: number[] = [];
  const service = new TaskDeletionService({
    database,
    taskboard,
    vault,
    provisioner,
    onRevisionCommitted: (revision) => revisions.push(revision),
  });
  return { database, project, provisioner, revisions, service, task, taskboard, vault, workspace };
}

function context(key: string) {
  return { actor: ADMIN_ACTOR, idempotencyKey: key, requestId: `request-${key}` };
}

function seedAttachmentAndThread(setupResult: ReturnType<typeof setup>) {
  const stored = setupResult.vault.store({
    filename: "evidence.txt",
    contentType: "text/plain",
    bytes: Buffer.from("delete evidence"),
  });
  setupResult.database
    .prepare(
      `INSERT INTO attachments (
        id, task_id, uploader_identity_key, filename, content_type, size_bytes, sha256, storage_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "10000000-0000-4000-8000-000000000001",
      setupResult.task.id,
      identityKey(ADMIN_ACTOR.identity),
      stored.filename,
      stored.contentType,
      stored.sizeBytes,
      stored.sha256,
      stored.storageKey,
    );
  setupResult.database
    .prepare(
      `INSERT INTO task_threads (id, task_id, thread_id, cwd, is_primary)
      VALUES (?, ?, ?, '/workspace', 1)`,
    )
    .run("20000000-0000-4000-8000-000000000001", setupResult.task.id, "thread-original");
  return stored;
}

describe("TaskDeletionService", () => {
  it("restores a canceled task and its quarantined attachments after deletion failed", async () => {
    const state = setup();
    const stored = seedAttachmentAndThread(state);
    state.provisioner.archiveError = new CodexRequestError(
      -32600,
      "thread thread-original already has an active writer",
    );
    await expect(
      state.service.delete(
        state.task.id,
        { expectedVersion: state.task.version },
        context("failed-delete"),
      ),
    ).rejects.toThrow(/Codex Desktop/);
    expect(() => state.vault.open(stored.storageKey)).toThrow();

    expect(() =>
      state.service.restoreTask(
        state.task.id,
        { expectedVersion: state.task.version - 1 },
        context("stale-restore"),
      ),
    ).toThrow(/版本/);
    expect(() => state.vault.open(stored.storageKey)).toThrow();

    const afterRestart = new TaskDeletionService({
      database: state.database,
      taskboard: state.taskboard,
      vault: state.vault,
      provisioner: state.provisioner,
    });
    const command = { expectedVersion: state.task.version };
    const restored = afterRestart.restoreTask(
      state.task.id,
      command,
      context("restore-failed-delete"),
    );
    expect(restored.task.status).toBe("backlog");
    expect(state.vault.open(stored.storageKey)).toBeDefined();
    expect(state.database.prepare("SELECT count(*) FROM task_delete_leases").pluck().get()).toBe(0);
    expect(
      afterRestart.restoreTask(state.task.id, command, context("restore-failed-delete")),
    ).toEqual(restored);
    await afterRestart.resumePending();
    expect(state.taskboard.readTask(state.task.id, ADMIN_ACTOR).status).toBe("backlog");
    expect(state.provisioner.archived).toEqual([]);
  });

  it("keeps the deletion lease if restoring the task fails and permits a later retry", async () => {
    const state = setup();
    const stored = seedAttachmentAndThread(state);
    state.provisioner.archiveError = new Error("archive unavailable");
    await expect(
      state.service.delete(
        state.task.id,
        { expectedVersion: state.task.version },
        context("delete-before-restore-failure"),
      ),
    ).rejects.toThrow();
    state.database.exec(
      "CREATE TRIGGER reject_restore BEFORE UPDATE OF status ON tasks WHEN NEW.status <> 'canceled' BEGIN SELECT RAISE(ABORT, 'restore unavailable'); END;",
    );
    expect(() =>
      state.service.restoreTask(
        state.task.id,
        { expectedVersion: state.task.version },
        context("restore-retry"),
      ),
    ).toThrow("restore unavailable");
    expect(state.database.prepare("SELECT count(*) FROM task_delete_leases").pluck().get()).toBe(1);
    expect(state.taskboard.readTask(state.task.id, ADMIN_ACTOR).status).toBe("canceled");
    state.database.exec("DROP TRIGGER reject_restore");
    expect(
      state.service.restoreTask(
        state.task.id,
        { expectedVersion: state.task.version },
        context("restore-retry"),
      ).task.status,
    ).toBe("backlog");
    expect(state.vault.open(stored.storageKey)).toBeDefined();
  });

  it("refuses restoration while archival is still in flight", async () => {
    const state = setup();
    const stored = seedAttachmentAndThread(state);
    const archive = deferred();
    const started = deferred();
    state.provisioner.archiveGate = archive.promise;
    state.provisioner.archiveStarted = started.resolve;
    const deleting = state.service.delete(
      state.task.id,
      { expectedVersion: state.task.version },
      context("active-delete"),
    );
    await started.promise;
    expect(() =>
      state.service.restoreTask(
        state.task.id,
        { expectedVersion: state.task.version },
        context("active-restore"),
      ),
    ).toThrow(/正在删除/);
    expect(() => state.vault.open(stored.storageKey)).toThrow();
    archive.resolve();
    await deleting;
  });

  it("explains a Desktop writer conflict and completes the same deletion after it is released", async () => {
    const state = setup();
    seedAttachmentAndThread(state);
    state.provisioner.archiveError = new CodexRequestError(
      -32600,
      "thread thread-original already has an active writer",
    );
    await expect(
      state.service.delete(
        state.task.id,
        { expectedVersion: state.task.version },
        context("desktop-archive"),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Codex Desktop"),
      details: { reason: "CODEX_DESKTOP_THREAD_BUSY", threadId: "thread-original" },
    });
    expect(state.taskboard.readTask(state.task.id, ADMIN_ACTOR).status).toBe("canceled");
    state.provisioner.archiveError = undefined;
    await expect(
      state.service.delete(
        state.task.id,
        { expectedVersion: state.task.version },
        context("desktop-archive"),
      ),
    ).resolves.toMatchObject({ taskId: state.task.id });
    expect(
      state.database.prepare("SELECT count(*) n FROM tasks WHERE id = ?").get(state.task.id),
    ).toEqual({ n: 0 });
  });
  it("deletes completed cancel jobs before their targets and task threads", async () => {
    const state = setup();
    seedAttachmentAndThread(state);
    const insert = state.database.prepare(`INSERT INTO jobs
      (id, task_id, task_thread_id, kind, status, execution_key, idempotency_key, target_job_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      "target",
      state.task.id,
      "20000000-0000-4000-8000-000000000001",
      "start",
      "canceled",
      "target",
      "target",
      null,
    );
    insert.run("cancel", state.task.id, null, "cancel", "succeeded", "cancel", "cancel", "target");
    const result = await state.service.delete(
      state.task.id,
      { expectedVersion: state.task.version },
      context("delete-with-cancel"),
    );
    expect(result.taskId).toBe(state.task.id);
    expect(
      state.database.prepare("SELECT count(*) n FROM jobs WHERE task_id=?").get(state.task.id),
    ).toEqual({ n: 0 });
    expect(state.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["done", "canceled"] as const)(
    "archives linked Codex tasks and physically deletes a %s task and its data",
    async (status) => {
      const state = setup(status);
      const stored = seedAttachmentAndThread(state);

      const result = await state.service.delete(
        state.task.id,
        DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
        context("delete-success"),
      );

      expect(result).toMatchObject({ taskId: state.task.id, projectId: state.project.id });
      expect(state.provisioner.archived).toEqual(["thread-original"]);
      expect(() => state.vault.open(stored.storageKey)).toThrow();
      expect(
        state.database
          .prepare("SELECT count(*) FROM tasks WHERE id = ?")
          .pluck()
          .get(state.task.id),
      ).toBe(0);
      expect(
        state.database
          .prepare("SELECT event_type FROM change_events WHERE aggregate_id = ? ORDER BY revision")
          .pluck()
          .all(state.task.id),
      ).toEqual(["task.deleted"]);
      expect(
        state.database
          .prepare("SELECT action FROM audit_events WHERE resource_id = ? ORDER BY created_at")
          .pluck()
          .all(state.task.id),
      ).toEqual(["task.delete"]);
      expect(state.revisions).toEqual([result.revision]);

      await expect(
        state.service.delete(
          state.task.id,
          DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
          context("delete-success"),
        ),
      ).resolves.toEqual(result);
      expect(state.provisioner.archived).toEqual(["thread-original"]);
    },
  );

  it("refuses physical deletion of active tasks", async () => {
    const state = setup();
    const active = state.taskboard.restoreTask(
      state.task.id,
      { expectedVersion: state.task.version },
      context("restore-active-task"),
    ).task;
    await expect(
      state.service.delete(
        active.id,
        { expectedVersion: active.version },
        context("delete-active"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(state.taskboard.readTask(active.id, ADMIN_ACTOR).status).toBe("backlog");
  });

  it("keeps a durable deletion operation when Codex archival fails and resumes it", async () => {
    const state = setup();
    const stored = seedAttachmentAndThread(state);
    state.provisioner.archiveError = new Error("archive unavailable");

    await expect(
      state.service.delete(
        state.task.id,
        DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
        context("delete-archive-failure"),
      ),
    ).rejects.toThrow(/归档/);

    expect(
      state.database.prepare("SELECT count(*) FROM tasks WHERE id = ?").pluck().get(state.task.id),
    ).toBe(1);
    expect(() => state.vault.open(stored.storageKey)).toThrow();
    expect(
      state.database
        .prepare("SELECT phase FROM task_delete_leases WHERE task_id = ?")
        .pluck()
        .get(state.task.id),
    ).toBe("archiving");

    state.provisioner.archiveError = undefined;
    await expect(
      state.service.delete(
        state.task.id,
        DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
        context("delete-archive-failure"),
      ),
    ).resolves.toMatchObject({ taskId: state.task.id });
    expect(state.provisioner.archived).toEqual(["thread-original"]);
  });

  it("rejects child-resource writes while Codex archival is pending, then completes deletion", async () => {
    const state = setup();
    seedAttachmentAndThread(state);
    const archive = deferred();
    const started = deferred();
    state.provisioner.archiveGate = archive.promise;
    state.provisioner.archiveStarted = started.resolve;

    const deleting = state.service.delete(
      state.task.id,
      DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
      context("delete-pending-write"),
    );
    await started.promise;

    expect(() =>
      state.workspace.createComment(
        state.task.id,
        CreateCommentCommandSchema.parse({ body: "不能在删除期间写入" }),
        context("delete-pending-comment"),
      ),
    ).toThrow(/正在删除/);

    archive.resolve();
    await expect(deleting).resolves.toMatchObject({ taskId: state.task.id });
  });

  it("keeps writes fenced after Codex archival failure until deletion is resumed", async () => {
    const state = setup();
    seedAttachmentAndThread(state);
    state.provisioner.archiveError = new Error("archive unavailable");

    await expect(
      state.service.delete(
        state.task.id,
        DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
        context("delete-release-lease"),
      ),
    ).rejects.toThrow(/归档/);

    expect(() =>
      state.workspace.createComment(
        state.task.id,
        CreateCommentCommandSchema.parse({ body: "归档失败后仍被栅栏阻止" }),
        context("delete-after-failure-comment"),
      ),
    ).toThrow(/正在删除/);
  });

  it("persists the finalizing phase after archival succeeds and resumes without re-archiving", async () => {
    const state = setup();
    seedAttachmentAndThread(state);
    const archive = deferred();
    const started = deferred();
    state.provisioner.archiveGate = archive.promise;
    state.provisioner.archiveStarted = started.resolve;

    const deleting = state.service.delete(
      state.task.id,
      DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
      context("delete-snapshot-change"),
    );
    await started.promise;
    state.database
      .prepare("INSERT INTO comments (id, task_id, body) VALUES (?, ?, ?)")
      .run("40000000-0000-4000-8000-000000000001", state.task.id, "并发关联数据");
    archive.resolve();

    await expect(deleting).rejects.toThrow(/关联数据已变化/);
    expect(
      state.database.prepare("SELECT count(*) FROM tasks WHERE id = ?").pluck().get(state.task.id),
    ).toBe(1);
    expect(
      state.database
        .prepare("SELECT body FROM comments WHERE id = ?")
        .pluck()
        .get("40000000-0000-4000-8000-000000000001"),
    ).toBe("并发关联数据");
    expect(
      state.database
        .prepare("SELECT phase FROM task_delete_leases WHERE task_id = ?")
        .pluck()
        .get(state.task.id),
    ).toBe("finalizing");
    expect(
      state.database
        .prepare(
          "SELECT event_type FROM task_delete_events WHERE task_id = ? ORDER BY created_at, rowid",
        )
        .pluck()
        .all(state.task.id),
    ).toEqual(["started", "archive_completed", "finalize_failed"]);
    expect(() =>
      state.workspace.createComment(
        state.task.id,
        CreateCommentCommandSchema.parse({ body: "协调期间继续拒绝写入" }),
        context("delete-finalizing-comment"),
      ),
    ).toThrow(/正在删除/);

    state.database
      .prepare("DELETE FROM comments WHERE id = ?")
      .run("40000000-0000-4000-8000-000000000001");
    state.database
      .prepare("UPDATE identities SET role = 'member' WHERE identity_key = ?")
      .run(identityKey(ADMIN_ACTOR.identity));
    state.database
      .prepare("DELETE FROM project_members WHERE identity_key = ?")
      .run(identityKey(ADMIN_ACTOR.identity));
    const replacementProvisioner = new RecordingProvisioner();
    const replacement = new TaskDeletionService({
      database: state.database,
      taskboard: state.taskboard,
      vault: state.vault,
      provisioner: replacementProvisioner,
    });
    await replacement.resumePending();

    expect(state.provisioner.archived).toEqual(["thread-original"]);
    expect(replacementProvisioner.archived).toEqual([]);
    expect(
      state.database.prepare("SELECT count(*) FROM tasks WHERE id = ?").pluck().get(state.task.id),
    ).toBe(0);
    expect(
      state.database
        .prepare(
          "SELECT event_type FROM task_delete_events WHERE task_id = ? ORDER BY created_at, rowid",
        )
        .pluck()
        .all(state.task.id),
    ).toEqual(["started", "archive_completed", "finalize_failed", "resumed", "completed"]);
  });

  it("takes over an interrupted persisted operation after restart without expiring its fence", async () => {
    const state = setup();
    seedAttachmentAndThread(state);
    const archive = deferred();
    const started = deferred();
    state.provisioner.archiveGate = archive.promise;
    state.provisioner.archiveStarted = started.resolve;

    const interrupted = state.service.delete(
      state.task.id,
      DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
      context("delete-restart"),
    );
    await started.promise;

    const replacementProvisioner = new RecordingProvisioner();
    const replacement = new TaskDeletionService({
      database: state.database,
      taskboard: state.taskboard,
      vault: state.vault,
      provisioner: replacementProvisioner,
    });
    await replacement.resumePending();

    expect(replacementProvisioner.archived).toEqual(["thread-original"]);
    expect(
      state.database.prepare("SELECT count(*) FROM tasks WHERE id = ?").pluck().get(state.task.id),
    ).toBe(0);
    expect(
      state.database
        .prepare(
          "SELECT event_type FROM task_delete_events WHERE task_id = ? ORDER BY created_at, rowid",
        )
        .pluck()
        .all(state.task.id),
    ).toEqual(["started", "resumed", "archive_completed", "completed"]);

    archive.resolve();
    await expect(interrupted).resolves.toMatchObject({ taskId: state.task.id });
  });

  it("refuses deletion while the task still has active execution work", async () => {
    const state = setup();
    const stored = seedAttachmentAndThread(state);
    state.database
      .prepare(
        `INSERT INTO jobs (
          id, task_id, task_thread_id, kind, status, execution_key, idempotency_key, requested_by_identity_key
        ) VALUES (?, ?, ?, 'continue', 'running', ?, ?, ?)`,
      )
      .run(
        "30000000-0000-4000-8000-000000000001",
        state.task.id,
        "20000000-0000-4000-8000-000000000001",
        `task:${state.task.id}`,
        "active-delete-job",
        identityKey(ADMIN_ACTOR.identity),
      );

    await expect(
      state.service.delete(
        state.task.id,
        DeleteTaskCommandSchema.parse({ expectedVersion: state.task.version }),
        context("delete-active-job"),
      ),
    ).rejects.toThrow(/执行中/);
    expect(state.provisioner.archived).toEqual([]);
    expect(state.vault.open(stored.storageKey).toString("utf8")).toBe("delete evidence");
  });
});
