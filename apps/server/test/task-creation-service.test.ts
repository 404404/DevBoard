import { identityKey } from "@codexboard/contracts";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import {
  CreateTaskCommandSchema,
  TEMPORARY_PROJECT_ID,
  type PrincipalView,
} from "@codexboard/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { type CodexThreadProvisioner, ExecutionQueue } from "../src/modules/execution/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard, TaskCreationService, TaskWorkspace } from "../src/modules/taskboard/index.js";

const ACTOR: PrincipalView = {
  identity: TEST_FEISHU_ACTOR.identity,
  name: "本机管理员",
  avatarUrl: null,
  role: "admin",
};
const openDatabases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
});

class FakeThreadProvisioner implements CodexThreadProvisioner {
  readonly created: Array<{ cwd: string | null; name: string }> = [];
  readonly archived: string[] = [];
  createError: Error | undefined;
  draftGate: Promise<void> | undefined;
  nextThreadId = "thread-draft-1";

  async createDraft(input: { readonly cwd: string | null; readonly name: string }) {
    this.created.push(input);
    await this.draftGate;
    if (this.createError) throw this.createError;
    return {
      threadId: this.nextThreadId,
      cwd: input.cwd ?? "/Users/test/Recent",
    };
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId);
  }
}

function setup() {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  seedFeishuTestActor(database, ACTOR);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "TASK",
    name: "任务项目",
    description: "",
  });
  const revisions: number[] = [];
  const taskboard = new Taskboard({
    database,
    identityService,
    onRevisionCommitted: (revision) => revisions.push(revision),
  });
  const queue = new ExecutionQueue({ database });
  const workspace = new TaskWorkspace({ database, identityService, taskboard });
  const provisioner = new FakeThreadProvisioner();
  const service = new TaskCreationService({
    taskboard,
    queue,
    provisioner,
    projectRegistry: {
      async resolveExecutionContext(projectId: string) {
        return {
          projectId,
          developmentContextId: null,
          cwd: "/Users/test/Projects/task",
          branch: null,
          headSha: null,
        };
      },
    },
  });
  return { database, project, provisioner, queue, revisions, service, taskboard, workspace };
}

const context = (key: string) => ({ actor: ACTOR, idempotencyKey: key, requestId: `req-${key}` });

describe("Task creation service", () => {
  it("rejects assigning a new task to another verified user before provisioning", async () => {
    const { database, project, service, provisioner } = setup();
    const outsider = seedFeishuTestActor(database, {
      ...ACTOR,
      identity: { kind: "feishu", tenantKey: "tenant", userId: "outsider" },
      role: "member",
    });
    await expect(
      service.create(
        CreateTaskCommandSchema.parse({
          projectId: project.id,
          title: "拒绝代指派",
          assigneeIdentity: outsider.identity,
        }),
        context("create-with-outsider-assignee"),
      ),
    ).rejects.toThrow("新任务负责人必须是当前发起人");
    expect(provisioner.created).toHaveLength(0);
    expect(database.prepare("SELECT count(*) FROM tasks").pluck().get()).toBe(0);
    expect(
      database
        .prepare("SELECT count(*) FROM project_members WHERE identity_key = ?")
        .pluck()
        .get(identityKey(outsider.identity)),
    ).toBe(0);
  });

  it("rejects service creators before provisioning or granting project access", async () => {
    const { database, project, service, provisioner } = setup();
    await expect(
      service.create(
        CreateTaskCommandSchema.parse({ projectId: project.id, title: "拒绝服务创建" }),
        {
          ...context("create-service-denied"),
          actor: { ...ACTOR, identity: { kind: "service", serviceId: "local-admin" } },
        },
      ),
    ).rejects.toThrow("创建任务需要已登录用户");
    expect(provisioner.created).toHaveLength(0);
    expect(database.prepare("SELECT count(*) FROM tasks").pluck().get()).toBe(0);
  });

  it("creates one named draft Thread for an idempotent Codex project task", async () => {
    const { project, provisioner, queue, service } = setup();
    const command = CreateTaskCommandSchema.parse({
      projectId: project.id,
      title: "项目待执行任务",
      status: "todo",
    });

    const first = await service.create(command, context("create-project-draft"));
    const replay = await service.create(command, context("create-project-draft"));

    expect(replay).toEqual(first);
    expect(first.task).toMatchObject({ codexThreadState: "draft" });
    expect(provisioner.created).toEqual([
      { cwd: "/Users/test/Projects/task", name: "TASK-001 项目待执行任务" },
    ]);
    expect(queue.primaryThread(first.task.id)).toMatchObject({
      threadId: "thread-draft-1",
      cwd: "/Users/test/Projects/task",
      lastTurnId: null,
      status: "idle",
    });
  });

  it("persists model options with the draft and replays creation without reprovisioning", async () => {
    const { database, project, provisioner, service } = setup();
    const modelOptions = { model: "test-model", effort: "high", serviceTier: "priority" };
    const command = CreateTaskCommandSchema.parse({
      projectId: project.id,
      title: "模型选择",
      modelOptions,
    });
    const result = await service.create(command, context("model-options"));
    expect(provisioner.created).toEqual([expect.objectContaining({ modelOptions })]);
    const restartedQueue = new ExecutionQueue({ database });
    expect(restartedQueue.primaryThread(result.task.id)?.modelOptions).toEqual(modelOptions);
    await service.create(command, context("model-options"));
    expect(provisioner.created).toHaveLength(1);
    await expect(
      service.create(
        { ...command, modelOptions: { ...modelOptions, effort: "low" } },
        context("model-options"),
      ),
    ).rejects.toThrow();
  });

  it("creates a temporary task in Codex Recent without a source folder", async () => {
    const { provisioner, queue, service } = setup();

    const result = await service.create(
      CreateTaskCommandSchema.parse({
        projectId: TEMPORARY_PROJECT_ID,
        title: "最近里的待执行任务",
      }),
      context("create-temporary-draft"),
    );

    expect(result.task).toMatchObject({
      projectId: TEMPORARY_PROJECT_ID,
      projectName: "临时项目",
      codexThreadState: "draft",
    });
    expect(provisioner.created).toEqual([{ cwd: null, name: "TEMP-001 最近里的待执行任务" }]);
    expect(queue.primaryThread(result.task.id)?.cwd).toBe("/Users/test/Recent");
  });

  it("removes the Taskboard task when Codex cannot create the draft", async () => {
    const { database, project, provisioner, service } = setup();
    provisioner.createError = new Error("Codex offline");

    await expect(
      service.create(
        CreateTaskCommandSchema.parse({ projectId: project.id, title: "不应残留" }),
        context("create-draft-failed"),
      ),
    ).rejects.toThrow("Codex offline");
    expect(
      database.prepare("SELECT count(*) FROM tasks WHERE archived_at IS NULL").pluck().get(),
    ).toBe(0);
    expect(
      database.prepare("SELECT count(*) FROM tasks WHERE archived_at IS NOT NULL").pluck().get(),
    ).toBe(1);
    expect(database.prepare("SELECT count(*) FROM request_idempotency").pluck().get()).toBe(0);
    const failedEvent = database
      .prepare(
        `SELECT aggregate_id AS aggregateId, safe_payload_json AS safePayloadJson
        FROM change_events WHERE event_type = 'task.creation_failed'`,
      )
      .get() as { aggregateId: string; safePayloadJson: string };
    expect(JSON.parse(failedEvent.safePayloadJson)).toEqual({
      projectId: project.id,
      taskId: failedEvent.aggregateId,
    });
  });

  it("removes initial relations and publishes deletion events when draft creation fails", async () => {
    const { database, project, provisioner, revisions, service, taskboard } = setup();
    const parent = taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "回滚父任务" }),
      context("rollback-parent"),
    ).task;
    const child = taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "回滚子任务" }),
      context("rollback-child"),
    ).task;
    const relatedFirst = taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "回滚关联一" }),
      context("rollback-related-first"),
    ).task;
    const relatedSecond = taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "回滚关联二" }),
      context("rollback-related-second"),
    ).task;
    provisioner.createError = new Error("Codex offline with initial relations");

    await expect(
      service.create(
        CreateTaskCommandSchema.parse({
          projectId: project.id,
          title: "关系必须一并回滚",
          initialRelations: {
            parentTaskId: parent.id,
            childTaskId: child.id,
            relatedTaskIds: [relatedFirst.id, relatedSecond.id],
          },
        }),
        context("rollback-initial-relations"),
      ),
    ).rejects.toThrow("Codex offline with initial relations");

    const failedTaskId = database
      .prepare("SELECT id FROM tasks WHERE title = '关系必须一并回滚'")
      .pluck()
      .get() as string;
    expect(taskboard.readTask(failedTaskId, ACTOR).archivedAt).not.toBeNull();
    expect(
      database
        .prepare(
          "SELECT count(*) FROM task_relations WHERE source_task_id = ? OR target_task_id = ?",
        )
        .pluck()
        .get(failedTaskId, failedTaskId),
    ).toBe(0);
    const rollbackEvents = database
      .prepare(
        `SELECT event_type AS eventType, safe_payload_json AS safePayloadJson
        FROM change_events
        WHERE json_extract(safe_payload_json, '$.taskId') = ?
          AND event_type IN ('relation.deleted', 'task.creation_failed')
        ORDER BY revision`,
      )
      .all(failedTaskId) as Array<{ eventType: string; safePayloadJson: string }>;
    expect(rollbackEvents.map((event) => event.eventType)).toEqual([
      "relation.deleted",
      "relation.deleted",
      "relation.deleted",
      "relation.deleted",
      "task.creation_failed",
    ]);
    expect(
      rollbackEvents.slice(0, -1).map((event) => JSON.parse(event.safePayloadJson).relatedTaskId),
    ).toEqual(expect.arrayContaining([parent.id, child.id, relatedFirst.id, relatedSecond.id]));
    expect(revisions.at(-1)).toBe(
      database.prepare("SELECT max(revision) FROM change_events").pluck().get(),
    );
  });

  it("preserves the task and all relations when a later relation appears before draft failure", async () => {
    const { database, project, provisioner, service, taskboard, workspace } = setup();
    const initialTarget = taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "初始关联目标" }),
      context("race-initial-target"),
    ).task;
    const laterTarget = taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "后续关联目标" }),
      context("race-later-target"),
    ).task;
    const originalError = new Error("delayed Codex failure");
    provisioner.createError = originalError;
    let releaseDraft!: () => void;
    provisioner.draftGate = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });

    const creating = service.create(
      CreateTaskCommandSchema.parse({
        projectId: project.id,
        title: "等待草稿时被继续编辑",
        initialRelations: {
          parentTaskId: null,
          childTaskId: null,
          relatedTaskIds: [initialTarget.id],
        },
      }),
      context("race-create"),
    );
    await vi.waitFor(() => expect(provisioner.created).toHaveLength(1));
    const pendingTaskId = database
      .prepare("SELECT id FROM tasks WHERE title = '等待草稿时被继续编辑'")
      .pluck()
      .get() as string;
    workspace.createRelation(
      pendingTaskId,
      { relationType: "related", targetTaskId: laterTarget.id },
      context("race-later-relation"),
    );
    releaseDraft();

    let failure: unknown;
    try {
      await creating;
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(originalError);
    expect((failure as AggregateError).errors).toEqual([
      originalError,
      expect.objectContaining({ message: "任务已有后续数据，不能撤销创建" }),
    ]);
    expect(taskboard.readTask(pendingTaskId, ACTOR).archivedAt).toBeNull();
    expect(
      workspace
        .readTaskWorkspace(pendingTaskId, ACTOR)
        .relations.map((relation) => relation.targetTaskId),
    ).toEqual(expect.arrayContaining([initialTarget.id, laterTarget.id]));
    expect(
      database
        .prepare(
          `SELECT count(*) FROM change_events
          WHERE aggregate_id = ? AND event_type IN ('relation.deleted', 'task.creation_failed')`,
        )
        .pluck()
        .get(pendingTaskId),
    ).toBe(0);
  });

  it("preserves a task updated and moved by another client before delayed draft creation fails", async () => {
    const { database, project, provisioner, service, taskboard } = setup();
    const originalError = new Error("delayed Codex failure after edit");
    provisioner.createError = originalError;
    let releaseDraft!: () => void;
    provisioner.draftGate = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });

    const creating = service.create(
      CreateTaskCommandSchema.parse({
        projectId: project.id,
        title: "等待草稿时被编辑",
      }),
      context("race-create-update"),
    );
    await vi.waitFor(() => expect(provisioner.created).toHaveLength(1));
    const pendingTask = taskboard.readTask(
      database
        .prepare("SELECT id FROM tasks WHERE title = '等待草稿时被编辑'")
        .pluck()
        .get() as string,
      ACTOR,
    );
    const updated = taskboard.updateTask(
      pendingTask.id,
      { expectedVersion: pendingTask.version, title: "另一客户端保留的标题" },
      context("race-user-update"),
    ).task;
    const moved = taskboard.moveTask(
      pendingTask.id,
      { expectedVersion: updated.version, targetStatus: "in_progress" },
      context("race-user-move"),
    ).task;
    releaseDraft();

    let failure: unknown;
    try {
      await creating;
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      originalError,
      expect.objectContaining({ message: "任务版本已变化，请重新加载" }),
    ]);
    expect(taskboard.readTask(pendingTask.id, ACTOR)).toMatchObject({
      title: "另一客户端保留的标题",
      status: "in_progress",
      version: moved.version,
      archivedAt: null,
    });
    expect(
      database
        .prepare(
          `SELECT count(*) FROM change_events
          WHERE aggregate_id = ? AND event_type = 'task.creation_failed'`,
        )
        .pluck()
        .get(pendingTask.id),
    ).toBe(0);
  });

  it("archives the Codex Thread and removes the task when binding fails", async () => {
    const { database, project, provisioner, service } = setup();
    database.exec(`
      CREATE TRIGGER fail_draft_binding
      BEFORE INSERT ON task_threads
      BEGIN
        SELECT RAISE(ABORT, 'forced binding failure');
      END;
    `);

    await expect(
      service.create(
        CreateTaskCommandSchema.parse({ projectId: project.id, title: "绑定失败" }),
        context("bind-draft-failed"),
      ),
    ).rejects.toThrow("forced binding failure");
    expect(provisioner.archived).toEqual(["thread-draft-1"]);
    expect(
      database.prepare("SELECT count(*) FROM tasks WHERE archived_at IS NULL").pluck().get(),
    ).toBe(0);
  });
});
