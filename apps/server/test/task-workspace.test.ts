import { seedProjectMember } from "./helpers/project-member-fixture.js";
import { identityKey } from "@codexboard/contracts";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import {
  CreateTaskCommandSchema,
  type PrincipalView,
  type CreateTaskCommand,
} from "@codexboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../src/app-error.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard, TaskWorkspace } from "../src/modules/taskboard/index.js";

const ADMIN_ACTOR: PrincipalView = {
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

function setup() {
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  seedFeishuTestActor(database, ADMIN_ACTOR);
  const administration = new ProjectAdministration(database);
  const firstProject = administration.createProject({
    projectKey: "WORK",
    name: "协作项目",
    description: "# 项目文档",
  });
  const secondProject = administration.createProject({
    projectKey: "OTHER",
    name: "其他项目",
    description: "",
  });
  const revisions: number[] = [];
  const taskboard = new Taskboard({ database, identityService });
  const workspace = new TaskWorkspace({
    database,
    identityService,
    onRevisionCommitted: (revision) => revisions.push(revision),
  });
  return { database, taskboard, workspace, firstProject, secondProject, revisions };
}

function createCommand(
  projectId: string,
  title: string,
  overrides: Partial<CreateTaskCommand> = {},
): CreateTaskCommand {
  return CreateTaskCommandSchema.parse({ projectId, title, ...overrides });
}

function mutation(idempotencyKey: string) {
  return { actor: ADMIN_ACTOR, idempotencyKey, requestId: `request-${idempotencyKey}` };
}

describe("TaskWorkspace", () => {
  it("uses one current actor avatar for assignees, historical comments and activities", async () => {
    const { database, taskboard, workspace, firstProject } = setup();
    const member = seedProjectMember(database, firstProject.id, {
      tenantKey: "tenant",
      userId: "ou_avatar",
      name: "头像成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    const grant = await new IdentityService({
      database,
      sessionTtlSeconds: 300,
      provider: {
        kind: "feishu",
        async exchangeCode() {
          return {
            identity: { kind: "feishu", tenantKey: "tenant", userId: "ou_avatar" },
            name: "头像成员",
            avatarUrl: null,
          };
        },
      },
    }).exchangeCode("avatar-code");
    const memberMutation = (key: string) => ({ ...mutation(key), actor: grant.actor });
    const task = taskboard.createTask(
      createCommand(firstProject.id, "头像来源", { assigneeIdentity: member.identity }),
      memberMutation("avatar-shared-task"),
    ).task;
    workspace.createComment(
      task.id,
      { body: "头像变更前的评论" },
      memberMutation("avatar-shared-comment"),
    );
    database
      .prepare("UPDATE identities SET avatar_url = ? WHERE identity_key = ?")
      .run("https://example.com/updated.png", identityKey(member.identity));
    const current = workspace.readTaskWorkspace(task.id, grant.actor);
    expect(current.comments[0]?.author?.avatarUrl).toBe("https://example.com/updated.png");
    expect(
      current.activities.every(
        (activity) => activity.actor?.avatarUrl === "https://example.com/updated.png",
      ),
    ).toBe(true);
    expect(taskboard.readBoard(firstProject.id, grant.actor).tasks[0]?.assignee?.avatarUrl).toBe(
      "https://example.com/updated.png",
    );
  });

  it("creates, edits and soft-deletes versioned comments atomically", () => {
    const { database, taskboard, workspace, firstProject, revisions } = setup();
    database
      .prepare("UPDATE identities SET avatar_url = ? WHERE identity_key = ?")
      .run("https://example.com/admin.png", identityKey(ADMIN_ACTOR.identity));
    const task = taskboard.createTask(
      createCommand(firstProject.id, "评论任务"),
      mutation("workspace-task-0001"),
    ).task;
    const revisionBeforeComments = database
      .prepare("SELECT max(revision) FROM change_events")
      .pluck()
      .get() as number;

    const created = workspace.createComment(
      task.id,
      { body: "**第一版**" },
      mutation("comment-create-0001"),
    );
    expect(created.data.author).toEqual({
      identity: ADMIN_ACTOR.identity,
      name: ADMIN_ACTOR.name,
      avatarUrl: "https://example.com/admin.png",
    });
    const updated = workspace.updateComment(
      created.data.id,
      { expectedVersion: created.data.version, body: "第二版" },
      mutation("comment-update-0002"),
    );

    expect(() =>
      workspace.updateComment(
        created.data.id,
        { expectedVersion: created.data.version, body: "过期修改" },
        mutation("comment-stale-0003"),
      ),
    ).toThrowError(AppError);

    const deleted = workspace.deleteComment(
      created.data.id,
      { expectedVersion: updated.data.version },
      mutation("comment-delete-0004"),
    );
    expect(deleted.data).toMatchObject({ body: "", version: 3 });
    expect(deleted.data.deletedAt).not.toBeNull();
    const taskWorkspace = workspace.readTaskWorkspace(task.id, ADMIN_ACTOR);
    expect(taskWorkspace.comments).toHaveLength(0);
    expect(taskWorkspace.activities[0]?.actor).toEqual({
      identity: ADMIN_ACTOR.identity,
      name: ADMIN_ACTOR.name,
      avatarUrl: "https://example.com/admin.png",
    });
    expect(database.prepare("SELECT count(*) FROM activities").pluck().get()).toBe(5);
    const commentEvents = database
      .prepare("SELECT event_type FROM change_events WHERE revision > ? ORDER BY revision")
      .all(revisionBeforeComments) as { event_type: string }[];
    expect(commentEvents.map((event) => event.event_type)).toEqual([
      "task.comment_pending",
      "comment.created",
      "comment.updated",
      "comment.deleted",
    ]);
    expect(database.prepare("SELECT max(revision) FROM change_events").pluck().get()).toBe(
      revisionBeforeComments + commentEvents.length,
    );
    expect(revisions).toEqual([created.revision, updated.revision, deleted.revision]);
  });

  it("rejects cross-project, self and cyclic parent relations", () => {
    const { database, taskboard, workspace, firstProject, secondProject } = setup();
    const parent = taskboard.createTask(
      createCommand(firstProject.id, "父任务"),
      mutation("relation-task-0001"),
    ).task;
    const child = taskboard.createTask(
      createCommand(firstProject.id, "子任务"),
      mutation("relation-task-0002"),
    ).task;
    const outsider = taskboard.createTask(
      createCommand(secondProject.id, "外部任务"),
      mutation("relation-task-0003"),
    ).task;

    const relation = workspace.createRelation(
      child.id,
      { relationType: "parent", targetTaskId: parent.id },
      mutation("relation-create-0004"),
    );
    expect(relation.data).toMatchObject({ taskId: child.id, relationType: "parent" });
    expect(workspace.readTaskWorkspace(parent.id, ADMIN_ACTOR).relations[0]).toMatchObject({
      taskId: parent.id,
      targetTaskId: child.id,
      relationType: "child",
    });
    expect(
      JSON.parse(
        database
          .prepare(
            "SELECT safe_payload_json FROM change_events WHERE event_type = 'relation.created'",
          )
          .pluck()
          .get() as string,
      ),
    ).toMatchObject({ taskId: child.id, relatedTaskId: parent.id });

    expect(() =>
      workspace.createRelation(
        parent.id,
        { relationType: "parent", targetTaskId: child.id },
        mutation("relation-cycle-0005"),
      ),
    ).toThrow(/循环/);
    expect(() =>
      workspace.createRelation(
        parent.id,
        { relationType: "related", targetTaskId: parent.id },
        mutation("relation-self-0006"),
      ),
    ).toThrow(/自身/);
    expect(() =>
      workspace.createRelation(
        parent.id,
        { relationType: "related", targetTaskId: outsider.id },
        mutation("relation-cross-0007"),
      ),
    ).toThrow(/同一项目/);
  });

  it("allows multiple children while keeping one parent per child", () => {
    const { taskboard, workspace, firstProject } = setup();
    const firstParent = taskboard.createTask(
      createCommand(firstProject.id, "第一个父任务"),
      mutation("unique-parent-task-0001"),
    ).task;
    const secondParent = taskboard.createTask(
      createCommand(firstProject.id, "第二个父任务"),
      mutation("unique-parent-task-0002"),
    ).task;
    const firstChild = taskboard.createTask(
      createCommand(firstProject.id, "第一个子任务"),
      mutation("unique-child-task-0003"),
    ).task;
    const secondChild = taskboard.createTask(
      createCommand(firstProject.id, "第二个子任务"),
      mutation("unique-child-task-0004"),
    ).task;
    workspace.createRelation(
      firstParent.id,
      { relationType: "child", targetTaskId: firstChild.id },
      mutation("unique-existing-relation-0005"),
    );

    workspace.createRelation(
      firstParent.id,
      { relationType: "child", targetTaskId: secondChild.id },
      mutation("multiple-child-relation-0006"),
    );
    expect(
      workspace
        .readTaskWorkspace(firstParent.id, ADMIN_ACTOR)
        .relations.filter((relation) => relation.relationType === "child")
        .map((relation) => relation.targetTaskId)
        .sort(),
    ).toEqual([firstChild.id, secondChild.id].sort());
    expect(() =>
      workspace.createRelation(
        secondParent.id,
        { relationType: "child", targetTaskId: firstChild.id },
        mutation("unique-child-conflict-0007"),
      ),
    ).toThrow(/子任务已有父任务/);
  });

  it("keeps terminal tasks out of dashboard lists and tracks active unread state", () => {
    const { database, taskboard, workspace, firstProject, revisions } = setup();
    taskboard.createTask(
      createCommand(firstProject.id, "已完成", { status: "done", priority: "high" }),
      mutation("dashboard-task-0001"),
    );
    taskboard.createTask(
      createCommand(firstProject.id, "已取消", { status: "canceled", priority: "low" }),
      mutation("dashboard-task-0002"),
    );
    const blocked = taskboard.createTask(
      createCommand(firstProject.id, "已阻塞", {
        status: "blocked",
        priority: "urgent",
        dueAt: "2026-09-01T00:00:00.000Z",
      }),
      mutation("dashboard-task-0003"),
    ).task;
    const active = taskboard.createTask(
      createCommand(firstProject.id, "待处理", { status: "todo", priority: "medium" }),
      mutation("dashboard-task-0004"),
    );

    const dashboard = workspace.readDashboard(firstProject.id, ADMIN_ACTOR);
    expect(dashboard).toMatchObject({
      totalTasks: 4,
      completedTasks: 1,
      completionPercent: 25,
      priorityCounts: { none: 0, urgent: 1, high: 1, medium: 1, low: 1 },
      blockedOrUnreadCount: 2,
      runningConversationCount: 0,
    });
    expect(dashboard.blockedOrUnreadTasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([blocked.id, active.task.id]),
    );

    const read = workspace.markTaskRead(active.task.id, mutation("dashboard-read-0005"));
    const replay = workspace.markTaskRead(active.task.id, mutation("dashboard-read-0005"));
    expect(replay).toEqual(read);
    expect(read.data).toMatchObject({
      taskId: active.task.id,
      lastReadVersion: active.task.version,
    });
    expect(
      database
        .prepare("SELECT count(*) FROM change_events WHERE event_type = 'task.read'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(revisions).toEqual([read.revision]);
    expect(workspace.readDashboard(firstProject.id, ADMIN_ACTOR).blockedOrUnreadCount).toBe(1);
  });
});

it("records exact changed task values and excludes unchanged submitted fields", () => {
  const { taskboard, workspace, firstProject } = setup();
  const task = taskboard.createTask(
    createCommand(firstProject.id, "旧标题", { priority: "medium", description: "旧描述" }),
    mutation("activity-values-create"),
  ).task;
  taskboard.updateTask(
    task.id,
    {
      expectedVersion: task.version,
      title: "新标题",
      description: "新描述",
      priority: "high",
      links: [],
    },
    mutation("activity-values-update"),
  );
  const activity = workspace
    .readTaskWorkspace(task.id, ADMIN_ACTOR)
    .activities.find(({ kind }) => kind === "task.updated")!;
  expect(activity.changes).toEqual({
    fields: ["title", "description", "priority"],
    values: {
      title: { from: "旧标题", to: "新标题" },
      description: { from: "旧描述", to: "新描述" },
      priority: { from: "medium", to: "high" },
    },
  });
});
