import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  CORE_MIGRATIONS,
  identityMigrations,
  openDatabase,
  runMigrations,
  type SqliteDatabase,
} from "../src/modules/database/index.js";
import { ExecutionQueue } from "../src/modules/execution/index.js";
import { IdentityService } from "../src/modules/identity/index.js";
import { TaskWorkspace } from "../src/modules/taskboard/index.js";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  runMigrations(
    database,
    CORE_MIGRATIONS.filter((migration) => migration.version <= 15),
  );
  const actor = {
    identity: { kind: "feishu" as const, tenantKey: "tenant", userId: "user" },
    id: randomUUID(),
    name: "author",
    avatarUrl: null,
    role: "admin" as const,
  };
  const taskId = randomUUID(),
    projectId = randomUUID();
  database
    .prepare(
      "INSERT INTO actors(id, tenant_key, open_id, name, role) VALUES (?, 'tenant', 'open', 'author', 'admin')",
    )
    .run(actor.id);
  database
    .prepare("INSERT INTO projects(id, project_key, name) VALUES (?, 'LEG', 'legacy')")
    .run(projectId);
  database
    .prepare(
      "INSERT INTO tasks(id, identifier, project_id, task_number, title, status) VALUES (?, 'LEG-1', ?, 1, 'legacy', 'todo')",
    )
    .run(taskId, projectId);
  function comment(body: string) {
    const id = randomUUID();
    database
      .prepare(
        "INSERT INTO comments(id, task_id, author_id, body, version, executed_at) VALUES (?, ?, ?, ?, 1, '2026-09-01T00:00:00.000Z')",
      )
      .run(id, taskId, actor.id, body);
    return id;
  }
  function job(status: string, context: object) {
    const id = randomUUID();
    database
      .prepare(
        "INSERT INTO jobs(id, task_id, kind, status, execution_key, idempotency_key, requested_by, work_context_json) VALUES (?, ?, 'start', ?, ?, ?, ?, ?)",
      )
      .run(id, taskId, status, id, id, actor.id, JSON.stringify(context));
    return id;
  }
  return { database, actor, taskId, projectId, comment, job };
}
it("repairs only premature same-version locks and includes edited failed comments in a new retry", async () => {
  const { database, actor, taskId, projectId, comment, job } = setup();
  const failed = comment("failed input"),
    success = comment("succeeded input"),
    unproven = comment("no evidence"),
    changed = comment("new version"),
    both = comment("succeeded and failed");
  job("failed", {
    commentSnapshot: [
      { id: failed, version: 1 },
      { id: both, version: 1 },
      { id: changed, version: 2 },
    ],
  });
  job("succeeded", {
    commentSnapshot: [
      { id: success, version: 1 },
      { id: both, version: 1 },
    ],
  });
  runMigrations(
    database,
    identityMigrations(
      (database.prepare("SELECT id FROM actors").all() as { id: string }[]).map((row) => ({
        legacyActorId: row.id,
        tenantKey: "tenant",
        openId: "open",
        userId: "user",
      })),
    ),
  );
  const locked = (id: string) =>
    database.prepare("SELECT executed_at FROM comments WHERE id = ?").pluck().get(id);
  expect(locked(failed)).toBeNull();
  for (const id of [success, unproven, changed, both]) expect(locked(id)).not.toBeNull();
  const identityService = new IdentityService({
    database,
    provider: {
      kind: "feishu",
      async exchangeCode() {
        return { identity: actor.identity, name: actor.name, avatarUrl: actor.avatarUrl };
      },
    },
    sessionTtlSeconds: 300,
  });
  const workspace = new TaskWorkspace({ database, identityService });
  // A historical identity mapping preserves authorship but does not prove a live login.
  expect(() =>
    workspace.updateComment(
      failed,
      { body: "unverified change", expectedVersion: 1 },
      { actor, idempotencyKey: "legacy-unverified-edit" },
    ),
  ).toThrow();
  const authenticatedActor = (await identityService.exchangeCode("verified-post-migration-login"))
    .actor;
  workspace.updateComment(
    failed,
    { body: "corrected failed input", expectedVersion: 1 },
    { actor: authenticatedActor, idempotencyKey: "legacy-edit-failed" },
  );
  expect(() =>
    workspace.updateComment(
      success,
      { body: "change", expectedVersion: 1 },
      { actor: authenticatedActor, idempotencyKey: "legacy-edit-success" },
    ),
  ).toThrow();
  const queued = new ExecutionQueue({ database }).submit(
    {
      taskId,
      kind: "start",
      executionKey: "/legacy",
      workContext: { cwd: "/legacy", projectId },
      maxAttempts: 2,
    },
    { actor: authenticatedActor, idempotencyKey: "legacy-retry" },
  );
  expect(queued.workContext.commentSnapshot).toEqual([{ id: failed, version: 2 }]);
  expect(queued.workContext.prompt).toContain("corrected failed input");
});
it.each(["canceled", "failed_recoverable", "canceling", "queued"])(
  "repairs a historical %s claim while retaining the old immutable prompt",
  (status) => {
    const { database, comment, job } = setup();
    const id = comment("retry input");
    const jobId = job(status, {
      commentSnapshot: [{ id, version: 1 }],
      prompt: "original bytes\n保持",
    });
    runMigrations(
      database,
      identityMigrations(
        (database.prepare("SELECT id FROM actors").all() as { id: string }[]).map((row) => ({
          legacyActorId: row.id,
          tenantKey: "tenant",
          openId: "open",
          userId: "user",
        })),
      ),
    );
    expect(
      database.prepare("SELECT executed_at FROM comments WHERE id = ?").pluck().get(id),
    ).toBeNull();
    expect(
      JSON.parse(
        database
          .prepare("SELECT work_context_json FROM jobs WHERE id = ?")
          .pluck()
          .get(jobId) as string,
      ).prompt,
    ).toBe("original bytes\n保持");
  },
);
it("pins a queued legacy attachment by its existing URL and stops retry if its bytes are already missing", () => {
  const { database, taskId, actor, job } = setup();
  const attachmentId = randomUUID();
  database
    .prepare(
      "INSERT INTO attachments(id, task_id, uploader_id, filename, content_type, size_bytes, sha256, storage_key) VALUES (?, ?, ?, 'old.txt', 'text/plain', 3, ?, 'ab/original')",
    )
    .run(attachmentId, taskId, actor.id, "a".repeat(64));
  const jobId = job("queued", {
    attachmentSnapshot: [{ id: attachmentId, filename: "old.txt", commentId: null }],
    prompt: `download ${attachmentId}`,
  });
  const missing = job("queued", {
    attachmentSnapshot: [{ id: randomUUID(), filename: "gone.txt", commentId: null }],
    prompt: "missing original",
  });
  runMigrations(
    database,
    identityMigrations(
      (database.prepare("SELECT id FROM actors").all() as { id: string }[]).map((row) => ({
        legacyActorId: row.id,
        tenantKey: "tenant",
        openId: "open",
        userId: "user",
      })),
    ),
  );
  expect(
    database
      .prepare(
        "SELECT job_id, original_attachment_id, storage_key FROM job_attachment_snapshots WHERE id = ?",
      )
      .get(attachmentId),
  ).toEqual({ job_id: jobId, original_attachment_id: attachmentId, storage_key: "ab/original" });
  database.prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
  expect(
    database
      .prepare("SELECT storage_key FROM job_attachment_snapshots WHERE id = ?")
      .pluck()
      .get(attachmentId),
  ).toBe("ab/original");
  expect(database.prepare("SELECT status, error_code FROM jobs WHERE id = ?").get(missing)).toEqual(
    { status: "failed_recoverable", error_code: "LEGACY_ATTACHMENT_SNAPSHOT_MISSING" },
  );
  expect(database.pragma("foreign_key_check")).toEqual([]);
});
