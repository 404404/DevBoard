import { identityKey } from "@lark-taskboard/contracts";
import { TEST_FEISHU_ACTOR, seedFeishuTestActor } from "./helpers/identity.js";
import type { PrincipalView, JobView } from "@lark-taskboard/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskWorkspace } from "../src/modules/taskboard/index.js";

import { AppError } from "../src/app-error.js";
import {
  CodexProtocolError,
  CodexRequestError,
  type CodexServerRequest,
} from "../src/modules/codex/index.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import {
  type CodexExecutionCallbacks,
  type CodexExecutionResult,
  type CodexExecutor,
  CodexDisconnectedError,
  ExecutionOrchestrator,
  ExecutionQueue,
  InteractionService,
} from "../src/modules/execution/index.js";
import { DevelopmentIdentityAdapter, IdentityService } from "../src/modules/identity/index.js";

const ACTOR: PrincipalView = TEST_FEISHU_ACTOR;
const TASK_ID = "20000000-0000-4000-8000-000000000001";
const openDatabases: SqliteDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
});

class FakeExecutor implements CodexExecutor {
  readonly starts: Array<{ cwd: string; prompt: string }> = [];
  readonly continuations: Array<{ threadId: string; cwd: string; prompt: string }> = [];
  readonly interruptions: Array<{ threadId: string; turnId: string }> = [];
  interaction:
    { method: CodexServerRequest["method"]; params: Record<string, unknown> } | undefined;
  interruptError: Error | undefined;
  result: CodexExecutionResult = {
    threadId: "codex-thread-1",
    turnId: "codex-turn-1",
    status: "completed",
  };

  async start(
    input: { readonly jobId: string; readonly cwd: string; readonly prompt: string },
    callbacks: CodexExecutionCallbacks,
  ): Promise<CodexExecutionResult> {
    this.starts.push(input);
    return this.#run(callbacks);
  }

  async continue(
    input: {
      readonly jobId: string;
      readonly threadId: string;
      readonly cwd: string;
      readonly prompt: string;
    },
    callbacks: CodexExecutionCallbacks,
  ): Promise<CodexExecutionResult> {
    this.continuations.push(input);
    return this.#run(callbacks);
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interruptions.push({ threadId, turnId });
    if (this.interruptError) throw this.interruptError;
  }

  async #run(callbacks: CodexExecutionCallbacks): Promise<CodexExecutionResult> {
    callbacks.onThread(this.result.threadId);
    callbacks.onTurn(this.result.turnId);
    callbacks.onEvent({
      cursor: "event-1",
      kind: "codex.agent_message",
      summary: "完成实现",
      safePayload: { phase: "final_answer" },
    });
    callbacks.onEvent({ cursor: "event-1", kind: "codex.agent_message", summary: "重复通知" });
    if (this.interaction) {
      const decision = await callbacks.onInteraction({
        id: "approval-1",
        method: this.interaction.method,
        params: {
          threadId: this.result.threadId,
          turnId: this.result.turnId,
          ...this.interaction.params,
        },
        async respond() {},
        async fail() {},
      });
      expect(decision.type).not.toBe("input");
    }
    return this.result;
  }
}

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
      ) VALUES (?, 'EXEC-1', ?, 1, '实现执行编排', 'todo', ?)`,
    )
    .run(TASK_ID, "10000000-0000-4000-8000-000000000001", identityKey(ACTOR.identity));
  const queue = new ExecutionQueue({ database });
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 3_600,
  });
  const interactions = new InteractionService({ database, queue, identityService });
  const executor = new FakeExecutor();
  const orchestrator = new ExecutionOrchestrator({
    queue,
    interactions,
    executor,
    owner: "worker-test",
    codexVersion: "0.150.1",
  });
  return {
    database,
    queue,
    interactions,
    executor,
    orchestrator,
    workspace: new TaskWorkspace({ database, identityService }),
  };
}

function submit(
  queue: ExecutionQueue,
  kind: "start" | "continue" = "start",
  taskThreadId?: string,
): JobView {
  return queue.submit(
    {
      taskId: TASK_ID,
      ...(taskThreadId ? { taskThreadId } : {}),
      kind,
      executionKey: `task:${TASK_ID}`,
      workContext: { cwd: "/workspace/project", prompt: "完成任务" },
      explicitPrompt: true,
      maxAttempts: 2,
    },
    { actor: ACTOR, idempotencyKey: `orchestrator-${kind}-${crypto.randomUUID()}` },
  );
}

describe("Codex execution orchestration", () => {
  it.each(["failed", "interrupted"] as const)(
    "keeps a capacity-stopped %s turn active until explicitly canceled, including after restart",
    async (status) => {
      const { database, queue, orchestrator, executor } = setup();
      const job = submit(queue);
      executor.result = {
        ...executor.result,
        status,
        errorSummary: "Selected model is at capacity. Please try a different model.",
      };
      await expect(orchestrator.runNext()).resolves.toMatchObject({
        status: "running",
        errorCode: "MODEL_AT_CAPACITY",
        completedAt: null,
      });
      expect(database.prepare("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({
        status: "in_progress",
      });
      queue.recoverAfterRestart();
      expect(queue.readJob(job.id).status).toBe("running");
      expect(queue.readJob(job.id).errorSummary).toContain("取消执行");
      await expect(orchestrator.runNext()).resolves.toBeNull();
      const canceled = queue.requestCancel(job.id, {
        actor: ACTOR,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(canceled.target.status).toBe("canceled");
      expect(canceled.cancel.status).toBe("succeeded");
      expect(database.prepare("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({
        status: "todo",
      });
      expect(executor.interruptions).toEqual([]);
    },
  );

  it.each([
    [-32001, "CODEX_DESKTOP_UNAVAILABLE"],
    [-32003, "CODEX_OUTCOME_UNKNOWN"],
  ])(
    "reports Desktop error %s without replaying a possibly accepted turn",
    async (code, errorCode) => {
      const { queue, orchestrator, executor } = setup();
      const queueJob = submit(queue);
      vi.spyOn(executor, "start").mockRejectedValue(
        new CodexRequestError(code, "private raw diagnostic"),
      );
      await expect(orchestrator.runNext()).resolves.toMatchObject({
        status: code === -32003 ? "canceling" : "failed",
        errorCode,
      });
      expect(queue.readJob(queueJob.id).errorSummary).not.toContain("private");
      await expect(orchestrator.runNext()).resolves.toBeNull();
    },
  );

  it("snapshots pending comments at submission, locks only success and sends them once to the existing thread", async () => {
    const { queue, orchestrator, workspace, executor } = setup();
    const context = () => ({ actor: ACTOR, idempotencyKey: crypto.randomUUID() });
    const originalTask = workspace.readTaskWorkspace(TASK_ID, ACTOR).task;
    submit(queue);
    await orchestrator.runNext();
    expect(executor.starts[0]!.prompt).toContain("$manage-lark-taskboard");
    expect(executor.starts[0]!.prompt).toContain("完成任务");
    const first = workspace.createComment(TASK_ID, { body: "修复键盘导航" }, context()).data;
    expect(workspace.readTaskWorkspace(TASK_ID, ACTOR).task.status).toBe("todo");
    const edited = workspace.updateComment(
      first.id,
      { expectedVersion: first.version, body: "修复键盘和焦点" },
      context(),
    ).data;
    const deleted = workspace.createComment(
      TASK_ID,
      { body: "不要发送已删除内容" },
      context(),
    ).data;
    workspace.deleteComment(deleted.id, { expectedVersion: deleted.version }, context());
    const second = workspace.createComment(TASK_ID, { body: "补充回归测试" }, context()).data;
    const job = submit(queue, "continue", queue.primaryThread(TASK_ID)!.id);
    await orchestrator.runNext();
    expect(executor.continuations[0]).toMatchObject({ threadId: "codex-thread-1" });
    const prompt = executor.continuations[0]!.prompt;
    expect(prompt).toContain("$manage-lark-taskboard");
    expect(prompt).toContain("修复键盘和焦点");
    expect(prompt).toContain("补充回归测试");
    expect(prompt).not.toContain("不要发送已删除内容");
    const comments = workspace.readTaskWorkspace(TASK_ID, ACTOR).comments;
    expect(workspace.readTaskWorkspace(TASK_ID, ACTOR).task).toMatchObject({
      title: originalTask.title,
      description: originalTask.description,
    });
    expect(comments.find((c) => c.id === first.id)?.body).toBe("修复键盘和焦点");
    expect(comments.find((c) => c.id === second.id)?.body).toBe("补充回归测试");
    expect(comments.find((c) => c.id === first.id)?.executedAt).toEqual(expect.any(String));
    expect(comments.find((c) => c.id === second.id)?.executedAt).toEqual(expect.any(String));
    expect(comments.find((c) => c.source === "codex")?.codexThreadId).toBe("codex-thread-1");
    expect(() =>
      workspace.updateComment(
        first.id,
        { expectedVersion: edited.version, body: "偷偷修改" },
        context(),
      ),
    ).toThrow(/执行/);
    expect(() =>
      workspace.deleteComment(second.id, { expectedVersion: second.version }, context()),
    ).toThrow(/执行/);
    const snapshot = queue.readJob(job.id).workContext.prompt;
    submit(queue, "continue", queue.primaryThread(TASK_ID)!.id);
    await orchestrator.runNext();
    expect(executor.continuations[1]!.prompt).not.toContain("修复键盘和焦点");
    expect(queue.readJob(job.id).workContext.prompt).toBe(snapshot);
  });

  it("keeps comments arriving during execution pending after the older run completes", () => {
    const { database, queue, workspace } = setup();
    const context = () => ({ actor: ACTOR, idempotencyKey: crypto.randomUUID() });
    const used = workspace.createComment(TASK_ID, { body: "本轮需求" }, context()).data;
    const job = submit(queue);
    const claimed = queue.claimNext("worker")!;
    expect(claimed.workContext.prompt).toContain("本轮需求");
    expect(
      workspace.updateComment(
        used.id,
        { expectedVersion: used.version, body: "修改后的本轮需求" },
        context(),
      ).data.executedAt,
    ).toBeNull();
    const later = workspace.createComment(TASK_ID, { body: "下一轮需求" }, context()).data;
    // Even a concurrent status change must not make completion hide pending work.
    database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(TASK_ID);
    queue.succeedAndRequestReview(job.id, "worker");
    const result = workspace.readTaskWorkspace(TASK_ID, ACTOR);
    expect(result.task.status).toBe("todo");
    expect(result.comments.find((c) => c.id === later.id)?.executedAt).toBeNull();
    expect(queue.readJob(job.id).workContext.prompt).not.toContain("下一轮需求");
  });

  it("rolls back the claim without consuming comment versions", () => {
    const { database, queue, workspace } = setup();
    const comment = workspace.createComment(
      TASK_ID,
      { body: "原子需求" },
      { actor: ACTOR, idempotencyKey: crypto.randomUUID() },
    ).data;
    const job = submit(queue);
    database.exec(
      "CREATE TRIGGER reject_running BEFORE INSERT ON job_events WHEN NEW.kind = 'job.running' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;",
    );
    expect(() => queue.claimNext("worker")).toThrow("test rollback");
    expect(queue.readJob(job.id).status).toBe("queued");
    expect(
      workspace.readTaskWorkspace(TASK_ID, ACTOR).comments.find((c) => c.id === comment.id)
        ?.executedAt,
    ).toBeNull();
    database.exec("DROP TRIGGER reject_running");
    expect(queue.claimNext("worker")?.workContext.prompt).toContain("原子需求");
  });

  it("reuses the original snapshot on retry and leaves later comments pending on failure", () => {
    const { queue, workspace, database } = setup();
    const context = () => ({ actor: ACTOR, idempotencyKey: crypto.randomUUID() });
    workspace.createComment(TASK_ID, { body: "首次需求" }, context());
    submit(queue);
    const claimed = queue.claimNext("worker")!;
    workspace.createComment(TASK_ID, { body: "重试不应追加" }, context());
    expect(
      queue.releaseForRetry(claimed.id, "worker", "CONNECTOR_DISCONNECTED", "断连").status,
    ).toBe("queued");
    const retry = queue.claimNext("worker")!;
    expect(retry.workContext).toEqual(claimed.workContext);
    expect(retry.workContext.prompt).not.toContain("重试不应追加");
    queue.fail(retry.id, "worker", "TURN_FAILED", "失败");
    expect(workspace.readTaskWorkspace(TASK_ID, ACTOR).task.status).toBe("todo");
    expect(
      database
        .prepare("SELECT executed_at FROM comments WHERE body = '重试不应追加'")
        .pluck()
        .get(),
    ).toBeNull();
  });

  it("publishes running status while keeping comments added after submission pending", () => {
    const { queue, workspace, database } = setup();
    submit(queue);
    workspace.createComment(
      TASK_ID,
      { body: "排队期间新增" },
      { actor: ACTOR, idempotencyKey: crypto.randomUUID() },
    );
    const before = database
      .prepare("SELECT MAX(revision) FROM change_events")
      .pluck()
      .get() as number;
    queue.claimNext("worker");
    expect(workspace.readTaskWorkspace(TASK_ID, ACTOR).task.status).toBe("in_progress");
    expect(
      database
        .prepare(
          "SELECT safe_payload_json AS payload FROM change_events WHERE revision > ? AND aggregate_type = 'task'",
        )
        .all(before),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payload: expect.stringContaining('"status":"in_progress"') }),
      ]),
    );
  });

  it("binds a draft Thread without creating a Job or Turn", () => {
    const { database, queue } = setup();

    const result = queue.bindDraftThread(TASK_ID, {
      threadId: "codex-thread-draft",
      cwd: "/workspace/project",
      codexVersion: "0.150.1",
    });

    expect(result.thread).toMatchObject({
      taskId: TASK_ID,
      threadId: "codex-thread-draft",
      cwd: "/workspace/project",
      lastTurnId: null,
      status: "idle",
    });
    expect(result.revision).toBeTypeOf("number");
    expect(database.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
    expect(
      database
        .prepare("SELECT event_type FROM change_events WHERE aggregate_id = ?")
        .pluck()
        .all(TASK_ID),
    ).toEqual(["codex.thread_created"]);
  });

  it("starts a thread and turn atomically, deduplicates events and advances only to review", async () => {
    const { database, queue, executor, orchestrator } = setup();
    const submitted = submit(queue);

    const completed = await orchestrator.runNext();

    expect(completed).toMatchObject({ id: submitted.id, status: "succeeded" });
    expect(executor.starts).toEqual([
      expect.objectContaining({
        cwd: "/workspace/project",
        prompt: expect.stringContaining("完成任务"),
      }),
    ]);
    expect(queue.primaryThread(TASK_ID)).toMatchObject({
      threadId: "codex-thread-1",
      lastTurnId: "codex-turn-1",
      lastEventCursor: "event-1",
      status: "completed",
    });
    expect(
      queue.readJob(submitted.id).events.filter((event) => event.kind === "codex.agent_message"),
    ).toHaveLength(1);
    expect(database.prepare("SELECT status FROM tasks WHERE id = ?").pluck().get(TASK_ID)).toBe(
      "in_review",
    );
  });

  it("shows deduplicated Codex replies in the conversation with full Markdown and excludes progress or unclassified replies", async () => {
    const { database, queue, orchestrator, workspace } = setup();
    const submitted = submit(queue);
    await orchestrator.runNext();
    const legacy = workspace.readTaskWorkspace(TASK_ID, ACTOR).comments;
    expect(legacy).toEqual([
      expect.objectContaining({ source: "codex", body: "完成实现", author: null }),
    ]);
    const fullText = "**完整回答**\n" + "内容".repeat(2000) + "\n末尾";
    database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(TASK_ID);
    const next = submit(queue, "continue", queue.primaryThread(TASK_ID)!.id);
    queue.claimNext("reply-worker");
    queue.bindExistingThread(next.id, "reply-worker", queue.primaryThread(TASK_ID)!.id);
    const event = {
      cursor: "reply-2",
      kind: "codex.agent_message",
      summary: fullText.slice(0, 2000),
      safePayload: { text: fullText, phase: "final_answer" },
    };
    for (const phase of ["commentary", null, undefined, "unknown"]) {
      queue.appendExecutionEvent(next.id, "reply-worker", {
        cursor: `progress-${String(phase)}`,
        kind: "codex.agent_message",
        summary: "我会先检查任务",
        safePayload: phase === undefined ? {} : { phase },
      });
    }
    expect(workspace.readTaskWorkspace(TASK_ID, ACTOR).comments).toHaveLength(1);
    queue.appendExecutionEvent(next.id, "reply-worker", event);
    queue.appendExecutionEvent(next.id, "reply-worker", event);
    const comments = workspace.readTaskWorkspace(TASK_ID, ACTOR).comments;
    expect(comments).toHaveLength(2);
    expect(comments[0]?.id).toBe(legacy[0]?.id);
    expect(comments[1]).toMatchObject({ source: "codex", body: fullText });
    expect(
      queue.readJob(submitted.id).events.filter((e) => e.kind === "codex.agent_message"),
    ).toHaveLength(1);
  });

  it("continues the primary thread without creating a replacement", async () => {
    const { database, queue, executor, orchestrator } = setup();
    submit(queue);
    await orchestrator.runNext();
    database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(TASK_ID);
    const thread = queue.primaryThread(TASK_ID)!;
    submit(queue, "continue", thread.id);

    await orchestrator.runNext();

    expect(executor.continuations).toEqual([
      expect.objectContaining({
        threadId: "codex-thread-1",
        cwd: "/workspace/project",
        prompt: expect.stringContaining("完成任务"),
      }),
    ]);
    expect(database.prepare("SELECT count(*) FROM task_threads").pluck().get()).toBe(1);
  });

  it("interrupts the mapped turn before committing both cancellation terminal states", async () => {
    const { queue, executor, orchestrator } = setup();
    const target = submit(queue);
    queue.claimNext("running-worker");
    queue.bindThread(target.id, "running-worker", {
      threadId: "codex-thread-1",
      cwd: "/workspace/project",
    });
    queue.recordTurn(target.id, "running-worker", "codex-turn-1");
    const cancellation = queue.requestCancel(target.id, {
      actor: ACTOR,
      idempotencyKey: "cancel-orchestrator-1",
    });

    const completed = await orchestrator.runNext();

    expect(executor.interruptions).toEqual([
      { threadId: "codex-thread-1", turnId: "codex-turn-1" },
    ]);
    expect(completed).toMatchObject({ id: cancellation.cancel.id, status: "succeeded" });
    expect(queue.readJob(target.id).status).toBe("canceled");
  });

  it("fails both cancellation records recoverably when interrupt cannot be delivered", async () => {
    const { queue, executor, orchestrator } = setup();
    const target = submit(queue);
    queue.claimNext("running-worker");
    queue.bindThread(target.id, "running-worker", {
      threadId: "codex-thread-1",
      cwd: "/workspace/project",
    });
    queue.recordTurn(target.id, "running-worker", "codex-turn-1");
    const cancellation = queue.requestCancel(target.id, {
      actor: ACTOR,
      idempotencyKey: "cancel-orchestrator-failure",
    });
    executor.interruptError = new CodexDisconnectedError("socket closed");

    await expect(orchestrator.runNext()).resolves.toMatchObject({
      id: cancellation.cancel.id,
      status: "failed_recoverable",
      errorCode: "CONNECTOR_DISCONNECTED",
    });
    expect(queue.readJob(target.id)).toMatchObject({
      status: "canceling",
      errorCode: "CONNECTOR_DISCONNECTED",
    });
  });

  it("persists approval, accepts one authorized decision and resumes the waiting job", async () => {
    const { database, queue, interactions, executor, orchestrator } = setup();
    executor.interaction = {
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test", reason: "运行测试" },
    };
    const job = submit(queue);
    const running = orchestrator.runNext();
    await vi.waitFor(() => expect(interactions.listForJob(job.id)).toHaveLength(1));
    const interaction = interactions.listForJob(job.id)[0]!;
    expect(queue.readJob(job.id).status).toBe("waiting_approval");
    expect(interaction).toMatchObject({
      status: "pending",
      kind: "command_approval",
      safeRequest: { command: "npm test", reason: "运行测试" },
    });

    expect(interactions.respond(interaction.id, { type: "accept" }, ACTOR)).toMatchObject({
      status: "responded",
      decidedBy: ACTOR.identity,
    });
    await expect(running).resolves.toMatchObject({ status: "succeeded" });
    expect(() => interactions.respond(interaction.id, { type: "decline" }, ACTOR)).toThrow(
      AppError,
    );
    expect(
      database
        .prepare("SELECT action FROM audit_events WHERE resource_type = 'interaction'")
        .pluck()
        .all(),
    ).toEqual(["interaction.respond"]);
  });

  it("retains uncertain disconnected execution without blindly replaying", async () => {
    const { queue, executor, orchestrator } = setup();
    const start = vi.spyOn(executor, "start");
    start.mockRejectedValueOnce(
      new CodexDisconnectedError("socket /Users/secret/private/codex.sock closed"),
    );
    const job = submit(queue);

    await expect(orchestrator.runNext()).resolves.toMatchObject({
      id: job.id,
      status: "canceling",
      attempt: 1,
      errorSummary: "Codex App Server 连接已中断",
    });
    expect(queue.readJob(job.id).errorSummary).not.toContain("/Users/secret/private");
    start.mockRestore();
    await expect(orchestrator.runNext()).resolves.toBeNull();
  });
  it("never interrupts the previous turn when a new turn starts after cancellation was requested", async () => {
    const { queue, executor, orchestrator } = setup();
    submit(queue);
    await orchestrator.runNext();
    let callbacks!: CodexExecutionCallbacks;
    let finish!: (result: CodexExecutionResult) => void;
    vi.spyOn(executor, "continue").mockImplementation(async (_input, nextCallbacks) => {
      callbacks = nextCallbacks;
      return await new Promise<CodexExecutionResult>((resolve) => {
        finish = resolve;
      });
    });
    const target = submit(queue, "continue", queue.primaryThread(TASK_ID)!.id);
    const running = orchestrator.runNext();
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const first = queue.requestCancel(target.id, {
      actor: ACTOR,
      idempotencyKey: "cancel-before-turn",
    });
    await orchestrator.runNext("cancel");
    expect(executor.interruptions).toEqual([]);
    expect(queue.readJob(first.cancel.id).status).toBe("failed_recoverable");
    callbacks.onTurn("codex-turn-2");
    expect(queue.readJob(target.id).recoveryCheckpoint).toMatchObject({ turnId: "codex-turn-2" });
    queue.requestCancel(target.id, { actor: ACTOR, idempotencyKey: "cancel-current-turn" });
    await orchestrator.runNext("cancel");
    expect(executor.interruptions).toEqual([
      { threadId: "codex-thread-1", turnId: "codex-turn-2" },
    ]);
    finish({ threadId: "codex-thread-1", turnId: "codex-turn-2", status: "completed" });
    await expect(running).resolves.toMatchObject({ status: "canceled" });
  });
  it("does not release or resend a turn whose RPC response timed out", async () => {
    const { queue, executor, orchestrator } = setup();
    const job = submit(queue);
    vi.spyOn(executor, "start").mockRejectedValue(
      new CodexProtocolError("Codex request timed out: turn/start"),
    );
    await expect(orchestrator.runNext()).resolves.toMatchObject({
      status: "canceling",
      errorCode: "CODEX_OUTCOME_UNKNOWN",
    });
    expect(() => submit(queue)).toThrow();
    expect(queue.readJob(job.id).completedAt).toBeNull();
  });
  it("releases uncertain cancellation when the matching execution later proves remote completion", async () => {
    const { queue, executor, orchestrator } = setup();
    let finish!: (result: CodexExecutionResult) => void;
    vi.spyOn(executor, "start").mockImplementation(async (_input, callbacks) => {
      callbacks.onThread("codex-thread-1");
      callbacks.onTurn("codex-turn-1");
      return await new Promise<CodexExecutionResult>((resolve) => {
        finish = resolve;
      });
    });
    const target = submit(queue);
    const running = orchestrator.runNext();
    await vi.waitFor(() =>
      expect(queue.readJob(target.id).recoveryCheckpoint?.turnId).toBe("codex-turn-1"),
    );
    const cancellation = queue.requestCancel(target.id, {
      actor: ACTOR,
      idempotencyKey: "cancel-then-complete",
    });
    executor.interruptError = new CodexDisconnectedError("unknown interrupt result");
    await orchestrator.runNext("cancel");
    expect(queue.readJob(target.id).status).toBe("canceling");
    finish({ threadId: "codex-thread-1", turnId: "codex-turn-1", status: "completed" });
    await expect(running).resolves.toMatchObject({ status: "canceled" });
    expect(queue.readJob(cancellation.cancel.id).status).toBe("failed_recoverable");
    expect(
      queue.requestCancel(target.id, { actor: ACTOR, idempotencyKey: "late-stop-confirmed" }).cancel
        .status,
    ).toBe("succeeded");
    expect(submit(queue).status).toBe("queued");
  });
  it("does not send a turn after cancellation arrives during workspace evidence capture", async () => {
    const { queue, executor, orchestrator } = setup();
    let finish!: () => void;
    vi.spyOn(queue, "captureWorkspaceStart").mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const job = submit(queue);
    const running = orchestrator.runNext();
    queue.requestCancel(job.id, { actor: ACTOR, idempotencyKey: "cancel-during-evidence" });
    finish();
    await expect(running).resolves.toMatchObject({ status: "canceled" });
    expect(executor.starts).toEqual([]);
    expect(submit(queue).status).toBe("queued");
  });
  it("automatically retries definitive thread-busy rejection with the same job and prompt, then exhausts the bound", async () => {
    const { queue, executor, orchestrator } = setup();
    const sent: { jobId: string; prompt: string }[] = [];
    vi.spyOn(executor, "start").mockImplementation(async (input) => {
      sent.push(input as { jobId: string; prompt: string });
      throw new CodexRequestError(-32002, "busy");
    });
    const job = submit(queue);
    await expect(orchestrator.runNext()).resolves.toMatchObject({ status: "queued", attempt: 1 });
    await expect(orchestrator.runNext()).resolves.toMatchObject({
      status: "failed_recoverable",
      attempt: 2,
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0]!.jobId).toBe(job.id);
    await expect(orchestrator.runNext()).resolves.toBeNull();
  });

  it.each(["running", "stopped"])(
    "recovers an unknown accepted turn after restart using its message identity (%s)",
    async (status) => {
      const { queue, executor, orchestrator } = setup();
      const job = submit(queue);
      vi.spyOn(executor, "start").mockImplementation(async (_input, callbacks) => {
        callbacks.onThread("codex-thread-1");
        callbacks.onDispatchState?.("sent");
        throw new CodexProtocolError("timed out waiting for turn/start");
      });
      await expect(orchestrator.runNext()).resolves.toMatchObject({ status: "canceling" });
      queue.recoverAfterRestart();
      const queries: unknown[] = [];
      Object.assign(executor, {
        reconcile: async (input: unknown) => {
          queries.push(input);
          return { status, turnId: "recovered-turn" };
        },
      });
      queue.requestCancel(job.id, { actor: ACTOR, idempotencyKey: "reconcile-after-restart" });
      await expect(orchestrator.runNext("cancel")).resolves.toMatchObject({ status: "succeeded" });
      expect(queries).toEqual([
        { jobId: job.id, threadId: "codex-thread-1", cwd: "/workspace/project" },
      ]);
      expect(executor.interruptions).toEqual(
        status === "running" ? [{ threadId: "codex-thread-1", turnId: "recovered-turn" }] : [],
      );
      expect(queue.readJob(job.id).status).toBe("canceled");
      expect(submit(queue).status).toBe("queued");
    },
  );

  it("does not permanently occupy a job when the adapter proves no turn was sent", async () => {
    const { queue, executor, orchestrator } = setup();
    const job = submit(queue);
    vi.spyOn(executor, "start").mockImplementation(async (_input, callbacks) => {
      callbacks.onDispatchState?.("not_sent");
      throw new CodexDisconnectedError("connect failed before sending");
    });
    await expect(orchestrator.runNext()).resolves.toMatchObject({ status: "queued" });
    await expect(orchestrator.runNext()).resolves.toMatchObject({ status: "failed_recoverable" });
    expect(queue.readJob(job.id).recoveryCheckpoint).toMatchObject({
      dispatchState: "not_sent",
      clientUserMessageId: job.id,
    });
    expect(submit(queue).status).toBe("queued");
  });
});

it.each(["preparation", "execution"] as const)(
  "stops safely while awaiting %s without touching a closed database",
  async (phase) => {
    const { database, queue, executor, orchestrator } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending =
      phase === "preparation"
        ? vi.spyOn(queue, "captureWorkspaceStart").mockImplementation(() => gate)
        : vi.spyOn(executor, "start").mockImplementation(async () => {
            await gate;
            return executor.result;
          });
    submit(queue);
    const running = orchestrator.runNext();
    await vi.waitFor(() => expect(pending).toHaveBeenCalled());
    orchestrator.stop();
    database.close();
    release();
    await expect(running).resolves.toBeNull();
    await expect(orchestrator.runNext()).resolves.toBeNull();
  },
);
