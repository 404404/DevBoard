import { identityKey } from "@codexboard/contracts";
import { TEST_FEISHU_ACTOR, seedFeishuTestActor } from "./helpers/identity.js";
import type { PrincipalView } from "@codexboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../src/app-error.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { ExecutionQueue } from "../src/modules/execution/index.js";

const ACTOR: PrincipalView = TEST_FEISHU_ACTOR;

const openDatabases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
});

function setup() {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  seedFeishuTestActor(database);
  database
    .prepare(
      "INSERT INTO projects (id, project_key, name, created_by_identity_key) VALUES (?, ?, ?, ?)",
    )
    .run("10000000-0000-4000-8000-000000000001", "EXEC", "执行项目", identityKey(ACTOR.identity));
  database
    .prepare(
      `INSERT INTO tasks (
        id, identifier, project_id, task_number, title, status, creator_identity_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "20000000-0000-4000-8000-000000000001",
      "EXEC-1",
      "10000000-0000-4000-8000-000000000001",
      1,
      "实现执行队列",
      "todo",
      identityKey(ACTOR.identity),
    );
  let now = new Date("2026-08-30T12:00:00.000Z");
  const committedRevisions: number[] = [];
  const queue = new ExecutionQueue({
    database,
    now: () => now,
    leaseDurationMs: 30_000,
    onRevisionCommitted: (revision) => committedRevisions.push(revision),
  });
  return {
    database,
    queue,
    committedRevisions,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

const taskId = "20000000-0000-4000-8000-000000000001";

function startCommand(overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    kind: "start" as const,
    executionKey: "/workspace/exec",
    workContext: {
      projectId: "10000000-0000-4000-8000-000000000001",
      cwd: "/workspace/exec",
      taskIdentifier: "EXEC-1",
    },
    maxAttempts: 2,
    ...overrides,
  };
}

function request(idempotencyKey: string) {
  return { actor: ACTOR, idempotencyKey, requestId: `request-${idempotencyKey}` };
}

describe("Execution queue", () => {
  it("submits idempotently, persists safe context and prevents concurrent task execution", () => {
    const { database, queue, committedRevisions } = setup();

    const first = queue.submit(startCommand(), request("job-start-0001"));
    const replay = queue.submit(startCommand(), request("job-start-0001"));

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      taskId,
      kind: "start",
      status: "queued",
      attempt: 0,
      maxAttempts: 2,
      workContext: { cwd: "/workspace/exec", taskIdentifier: "EXEC-1" },
    });
    expect(committedRevisions).toHaveLength(1);
    expect(database.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM job_events").pluck().get()).toBe(1);
    expect(database.prepare("SELECT status FROM tasks WHERE id = ?").pluck().get(taskId)).toBe(
      "in_progress",
    );
    expect(() =>
      queue.submit(startCommand({ kind: "continue" }), request("job-start-0002")),
    ).toThrowError(AppError);
    expect(() =>
      queue.submit(startCommand({ maxAttempts: 3 }), request("job-start-0001")),
    ).toThrowError(AppError);
  });

  it("claims atomically, renews the lease and retries only before the attempt limit", () => {
    const { database, queue, advance } = setup();
    queue.submit(startCommand(), request("job-claim-0001"));
    const competingQueue = new ExecutionQueue({ database, leaseDurationMs: 30_000 });

    const claimed = queue.claimNext("worker-a");
    expect(claimed).toMatchObject({ status: "running", attempt: 1, leaseOwner: "worker-a" });
    expect(competingQueue.claimNext("worker-b")).toBeNull();

    advance(10_000);
    expect(queue.heartbeat(claimed!.id, "worker-a", { eventCursor: "cursor-1" })).toMatchObject({
      status: "running",
      recoveryCheckpoint: { eventCursor: "cursor-1" },
    });
    expect(
      queue.releaseForRetry(claimed!.id, "worker-a", "CONNECTOR_DISCONNECTED", "连接中断"),
    ).toMatchObject({ status: "queued", attempt: 1 });
    const retried = queue.claimNext("worker-b");
    expect(retried).toMatchObject({ status: "running", attempt: 2, leaseOwner: "worker-b" });
    expect(
      queue.releaseForRetry(retried!.id, "worker-b", "CONNECTOR_DISCONNECTED", "再次中断"),
    ).toMatchObject({ status: "failed_recoverable", attempt: 2 });
  });

  it("prioritizes cancellation and keeps terminal states irreversible", () => {
    const { queue } = setup();
    const target = queue.submit(startCommand(), request("job-cancel-0001"));
    queue.claimNext("worker-a");
    const cancellation = queue.requestCancel(target.id, request("job-cancel-0002"));

    expect(cancellation.target).toMatchObject({ status: "canceling" });
    expect(cancellation.cancel).toMatchObject({ kind: "cancel", status: "queued" });
    expect(queue.claimNext("worker-b")).toMatchObject({ id: cancellation.cancel.id });
    const completed = queue.completeCancellation(cancellation.cancel.id, "worker-b");
    expect(completed.target.status).toBe("canceled");
    expect(completed.cancel.status).toBe("succeeded");
    expect(() => queue.succeed(target.id, "worker-a", { summary: "不应成功" })).toThrowError(
      AppError,
    );
  });

  it("keeps queued work but fails uncertain running work closed after restart", () => {
    const { database, queue } = setup();
    const running = queue.submit(startCommand(), request("job-recover-0001"));
    queue.claimNext("worker-before-restart");
    const queued = queue.submit(
      startCommand({ taskId: createSecondTask(database), executionKey: "/workspace/second" }),
      request("job-recover-0002"),
    );

    const recovered = queue.recoverAfterRestart();

    expect(recovered).toEqual([expect.objectContaining({ id: running.id, status: "canceling" })]);
    expect(queue.readJob(queued.id)).toMatchObject({ status: "queued" });
  });
  it("confirms only unchanged live comment versions on success and rolls the transaction back on failure", () => {
    const { database, queue } = setup();
    const ids = [1, 2, 3].map((n) => `30000000-0000-4000-8000-00000000000${n}`);
    for (const id of ids)
      database
        .prepare(
          "INSERT INTO comments (id, task_id, author_identity_key, body) VALUES (?, ?, ?, ?)",
        )
        .run(id, taskId, identityKey(ACTOR.identity), id);
    const job = queue.submit(startCommand(), request("snapshot-start"));
    queue.claimNext("worker");
    expect(database.prepare("SELECT executed_at FROM comments").pluck().all()).toEqual([
      null,
      null,
      null,
    ]);
    database
      .prepare("UPDATE comments SET version = version + 1, body = 'changed' WHERE id = ?")
      .run(ids[1]);
    database
      .prepare("UPDATE comments SET deleted_at = '2026-09-07T00:00:00.000Z' WHERE id = ?")
      .run(ids[2]);
    database.exec(
      "CREATE TRIGGER reject_success BEFORE INSERT ON job_events WHEN NEW.kind = 'job.succeeded' BEGIN SELECT RAISE(ABORT, 'rollback success'); END;",
    );
    expect(() => queue.succeedAndRequestReview(job.id, "worker")).toThrow("rollback success");
    expect(database.prepare("SELECT executed_at FROM comments").pluck().all()).toEqual([
      null,
      null,
      null,
    ]);
    database.exec("DROP TRIGGER reject_success");
    queue.succeedAndRequestReview(job.id, "worker");
    expect(database.prepare("SELECT executed_at FROM comments").pluck().all()).toEqual([
      expect.any(String),
      null,
      null,
    ]);
    expect(database.prepare("SELECT status FROM tasks WHERE id = ?").pluck().get(taskId)).toBe(
      "todo",
    );
  });

  it("returns the existing cancellation for different request keys and treats late cancellation as success", () => {
    const { queue } = setup();
    const job = queue.submit(startCommand(), request("cancel-idempotent-start"));
    queue.claimNext("worker");
    const first = queue.requestCancel(job.id, request("cancel-first"));
    expect(queue.requestCancel(job.id, request("cancel-second")).cancel.id).toBe(first.cancel.id);
    queue.claimNext("cancel-worker");
    queue.completeCancellation(first.cancel.id, "cancel-worker");
    expect(queue.requestCancel(job.id, request("cancel-third")).target.status).toBe("canceled");
    const next = queue.submit(startCommand(), request("late-start"));
    queue.claimNext("worker");
    queue.succeedAndRequestReview(next.id, "worker");
    expect(queue.requestCancel(next.id, request("late-cancel"))).toMatchObject({
      target: { status: "succeeded" },
      cancel: { status: "succeeded" },
    });
  });

  it("retains the execution slot after uncertain cancellation and permits retrying its remote stop", () => {
    const { queue } = setup();
    const job = queue.submit(startCommand(), request("uncertain-start"));
    queue.claimNext("worker");
    const first = queue.requestCancel(job.id, request("uncertain-cancel"));
    queue.claimNext("cancel-worker");
    queue.failCancellation(first.cancel.id, "cancel-worker", "CONNECTOR_DISCONNECTED", "unknown");
    expect(queue.readJob(job.id).status).toBe("canceling");
    expect(() => queue.submit(startCommand(), request("overlap"))).toThrow();
    const retry = queue.requestCancel(job.id, request("retry-cancel"));
    expect(retry.cancel.status).toBe("queued");
    queue.claimNext("cancel-worker");
    queue.completeCancellation(retry.cancel.id, "cancel-worker");
    expect(queue.submit(startCommand(), request("after-stop")).status).toBe("queued");
  });

  it("rejects empty successful continuation but accepts new comments, explicit prompts and failed retries", () => {
    const { database, queue } = setup();
    const initial = queue.submit(startCommand({ kind: "continue" }), request("draft"));
    queue.claimNext("worker");
    queue.succeedAndRequestReview(initial.id, "worker");
    expect(() => queue.submit(startCommand({ kind: "continue" }), request("empty"))).toThrow(
      /待执行/,
    );
    const explicit = queue.submit(
      startCommand({
        kind: "continue",
        explicitPrompt: true,
        workContext: { prompt: "check again" },
      }),
      request("explicit"),
    );
    queue.claimNext("worker");
    queue.fail(explicit.id, "worker", "TURN_FAILED", "failed");
    expect(database.prepare("SELECT status FROM tasks WHERE id = ?").pluck().get(taskId)).toBe(
      "todo",
    );
    const retry = queue.submit(startCommand({ kind: "continue" }), request("retry-failed"));
    queue.claimNext("worker");
    queue.succeedAndRequestReview(retry.id, "worker");
    database
      .prepare(
        "INSERT INTO comments (id, task_id, author_identity_key, body) VALUES (?, ?, ?, 'new')",
      )
      .run("30000000-0000-4000-8000-000000000001", taskId, identityKey(ACTOR.identity));
    expect(queue.submit(startCommand({ kind: "continue" }), request("new-comment")).status).toBe(
      "queued",
    );
  });

  it("manual retries replace old comment versions and deleted instructions while auto retries stay identical", () => {
    const { database, queue } = setup();
    const commentId = "30000000-0000-4000-8000-000000000001";
    const removedId = "30000000-0000-4000-8000-000000000002";
    for (const id of [commentId, removedId])
      database
        .prepare(
          "INSERT INTO comments (id, task_id, author_identity_key, body) VALUES (?, ?, ?, 'old')",
        )
        .run(id, taskId, identityKey(ACTOR.identity));
    const old = queue.submit(startCommand(), request("manual-old"));
    queue.claimNext("worker");
    queue.fail(old.id, "worker", "TURN_FAILED", "failed");
    database
      .prepare("UPDATE comments SET body = 'new version', version = 2 WHERE id = ?")
      .run(commentId);
    database
      .prepare("UPDATE comments SET deleted_at = '2026-09-07T00:00:00.000Z' WHERE id = ?")
      .run(removedId);
    queue.submit(startCommand({ kind: "continue" }), request("manual-new"));
    const fresh = queue.claimNext("worker")!;
    expect(fresh.workContext.supersedesJobId).toBe(old.id);
    expect(fresh.workContext.commentSnapshot).toEqual([
      expect.objectContaining({ id: commentId, version: 2 }),
    ]);
    expect(fresh.workContext.prompt).toContain("new version");
    expect(fresh.workContext.prompt).toContain(removedId);
    expect(fresh.workContext.prompt).toMatch(/替代|失效/);
    queue.releaseForRetry(fresh.id, "worker", "NOT_SENT", "not sent");
    database.prepare("UPDATE comments SET body = 'later', version = 3 WHERE id = ?").run(commentId);
    expect(queue.claimNext("worker")!.workContext).toEqual(fresh.workContext);
  });

  it("freezes the comment body at submission and leaves queued edits pending", () => {
    const { database, queue } = setup();
    const id = "30000000-0000-4000-8000-000000000001";
    database
      .prepare(
        "INSERT INTO comments (id, task_id, author_identity_key, body) VALUES (?, ?, ?, 'submitted body')",
      )
      .run(id, taskId, identityKey(ACTOR.identity));
    const submitted = queue.submit(startCommand(), request("queued-snapshot"));
    expect(submitted.workContext.commentSnapshot).toEqual([{ id, version: 1 }]);
    database.prepare("UPDATE comments SET body = 'queued edit', version = 2 WHERE id = ?").run(id);
    const claimed = queue.claimNext("worker")!;
    expect(claimed.workContext.prompt).toContain("submitted body");
    expect(claimed.workContext.prompt).not.toContain("queued edit");
    queue.succeedAndRequestReview(submitted.id, "worker");
    expect(
      database.prepare("SELECT executed_at FROM comments WHERE id = ?").pluck().get(id),
    ).toBeNull();
  });
  it("keeps queued automatic retries in progress even when a comment arrived during the previous attempt", () => {
    const { database, queue } = setup();
    const job = queue.submit(startCommand(), request("retry-status"));
    queue.claimNext("worker");
    database.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
    queue.releaseForRetry(job.id, "worker", "NOT_SENT", "not accepted");
    expect(database.prepare("SELECT status FROM tasks WHERE id = ?").pluck().get(taskId)).toBe(
      "in_progress",
    );
  });

  it("preserves current turn identity across heartbeat updates and rejects a mismatched successful turn", () => {
    const { queue } = setup();
    const job = queue.submit(startCommand(), request("turn-identity"));
    queue.claimNext("worker");
    queue.bindThread(job.id, "worker", { threadId: "thread-1", cwd: "/workspace/exec" });
    queue.recordTurn(job.id, "worker", "turn-current");
    expect(
      queue.heartbeat(job.id, "worker", { eventCursor: "progress" }).recoveryCheckpoint,
    ).toMatchObject({ turnId: "turn-current" });
    expect(() => queue.succeedAndRequestReview(job.id, "worker", { turnId: "turn-old" })).toThrow(
      /轮次/,
    );
    expect(queue.readJob(job.id).status).toBe("running");
  });
});

function createSecondTask(database: SqliteDatabase): string {
  const secondTaskId = "20000000-0000-4000-8000-000000000002";
  database
    .prepare(
      `INSERT INTO tasks (
        id, identifier, project_id, task_number, title, status, creator_identity_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      secondTaskId,
      "EXEC-2",
      "10000000-0000-4000-8000-000000000001",
      2,
      "第二个执行任务",
      "todo",
      identityKey(ACTOR.identity),
    );
  return secondTaskId;
}

it("persists non-dispatch evidence in the claim transaction before any asynchronous preparation", () => {
  const { queue } = setup();
  const job = queue.submit(startCommand(), request("claim-before-preparation"));
  const claimed = queue.claimNext("worker");
  expect(claimed?.recoveryCheckpoint).toMatchObject({ dispatchState: "not_sent", turnId: null });
  queue.recoverAfterRestart();
  expect(queue.readJob(job.id).recoveryCheckpoint).toMatchObject({ dispatchState: "not_sent" });
});
