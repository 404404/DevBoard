import { openDatabase, runMigrations, CORE_MIGRATIONS } from "../src/modules/database/index.js";
import {
  UpdateTaskCommandSchema,
  ALL_PROJECT_ID,
  TEMPORARY_PROJECT_ID,
} from "@lark-codex/contracts";
import { identityKey, CreateTaskCommandSchema, type PrincipalView } from "@lark-codex/contracts";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { DevelopmentIdentityAdapter, IdentityService } from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard, TaskWorkspace } from "../src/modules/taskboard/index.js";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function setup() {
  const database = initializeDatabase(":memory:");
  databases.push(database);
  const actor = seedFeishuTestActor(database);
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  const project = new ProjectAdministration(database).createProject({
    projectKey: "ID",
    name: "Identity",
    description: "",
  });
  const taskboard = new Taskboard({ database, identityService });
  const workspace = new TaskWorkspace({ database, identityService, taskboard });
  return { database, actor, project, taskboard, workspace };
}

it("offers only the current authenticated Feishu user as assignee", () => {
  const { database, actor, project, taskboard } = setup();
  const other = seedFeishuTestActor(database, {
    ...actor,
    identity: { kind: "feishu", tenantKey: "another-tenant", userId: "another-user" },
  });
  expect(
    taskboard.readTaskCreationOptions(project.id, actor, () => []).assignees.map((x) => x.identity),
  ).toEqual([actor.identity]);
  expect(
    taskboard.readTaskCreationOptions(project.id, other, () => []).assignees.map((x) => x.identity),
  ).toEqual([other.identity]);
});

it("rejects assigning another verified user or clearing the owner, and permits claiming as the acting user", () => {
  const { database, actor, project, taskboard } = setup();
  const other = seedFeishuTestActor(database, {
    ...actor,
    identity: { kind: "feishu", tenantKey: "another-tenant", userId: "another-user" },
  });
  const task = taskboard.createTask(
    CreateTaskCommandSchema.parse({ projectId: project.id, title: "Owned task" }),
    { actor, idempotencyKey: "owner-created" },
  ).task;
  for (const assigneeIdentity of [other.identity, null]) {
    expect(() =>
      taskboard.updateTask(
        task.id,
        UpdateTaskCommandSchema.parse({ expectedVersion: task.version, assigneeIdentity }),
        { actor, idempotencyKey: "reject-owner-" + String(assigneeIdentity === null) },
      ),
    ).toThrow("负责人必须是当前登录用户");
  }
  const claimed = taskboard.updateTask(
    task.id,
    UpdateTaskCommandSchema.parse({
      expectedVersion: task.version,
      assigneeIdentity: other.identity,
    }),
    { actor: other, idempotencyKey: "claim-own-identity" },
  ).task;
  expect(claimed.assigneeIdentity).toEqual(other.identity);
  expect(database.prepare("SELECT COUNT(*) FROM project_members").pluck().get()).toBe(0);
});

it("verified members can operate the board without administrator roles or project memberships", () => {
  const { database, actor, project, taskboard } = setup();
  database
    .prepare(
      "UPDATE projects SET source_kind = 'codex', codex_project_id = 'identity-project', sync_position = 0, root_paths_json = '[\"/tmp/identity-project\"]' WHERE id = ?",
    )
    .run(project.id);
  const member = seedFeishuTestActor(database, {
    ...actor,
    role: "member",
    identity: { kind: "feishu", tenantKey: "other", userId: "member" },
  });
  const task = taskboard.createTask(
    CreateTaskCommandSchema.parse({ projectId: project.id, title: "Shared" }),
    { actor, idempotencyKey: "shared-project-task" },
  ).task;
  const temporary = taskboard.createTask(
    CreateTaskCommandSchema.parse({ projectId: TEMPORARY_PROJECT_ID, title: "Temporary" }),
    { actor, idempotencyKey: "shared-temp-task" },
  ).task;
  expect(taskboard.listProjects(member).map((p) => p.id)).toContain(project.id);
  expect(taskboard.readBoard(ALL_PROJECT_ID, member).tasks.map((t) => t.id)).toEqual(
    expect.arrayContaining([task.id, temporary.id]),
  );
  expect(taskboard.readTask(task.id, member).permissions).toMatchObject({
    canRead: true,
    canWrite: true,
    canExecute: true,
  });
  const edited = taskboard.updateTask(
    task.id,
    { expectedVersion: task.version, title: "Updated" },
    { actor: member, idempotencyKey: "member-edit" },
  ).task;
  expect(edited.title).toBe("Updated");
  expect(edited.assigneeIdentity).toEqual(actor.identity);
  expect(database.prepare("SELECT COUNT(*) FROM project_members").pluck().get()).toBe(0);
});

it("persists natural keys and returns structured creator, assignee, comment and activity identities", () => {
  const { database, actor, project, taskboard, workspace } = setup();
  const task = taskboard.createTask(
    CreateTaskCommandSchema.parse({ projectId: project.id, title: "identity" }),
    { actor, idempotencyKey: "create-identity" },
  ).task;
  expect(task.creatorIdentity).toEqual(TEST_FEISHU_ACTOR.identity);
  expect(task.assigneeIdentity).toEqual(TEST_FEISHU_ACTOR.identity);
  expect(task.assignee?.identity).toEqual(TEST_FEISHU_ACTOR.identity);
  expect(
    database
      .prepare(
        "SELECT assignee_identity_key AS assignee, creator_identity_key AS creator FROM tasks WHERE id = ?",
      )
      .get(task.id),
  ).toEqual({
    assignee: '["feishu","test-tenant","test-admin"]',
    creator: '["feishu","test-tenant","test-admin"]',
  });
  const comment = workspace.createComment(
    task.id,
    { body: "comment" },
    { actor, idempotencyKey: "comment-identity" },
  ).data;
  expect(comment.author?.identity).toEqual(TEST_FEISHU_ACTOR.identity);
  expect(workspace.readTaskWorkspace(task.id, actor).activities[0]?.actor?.identity).toEqual(
    TEST_FEISHU_ACTOR.identity,
  );
  const options = taskboard.readTaskCreationOptions(project.id, actor, () => []);
  expect(options.currentIdentity).toEqual(TEST_FEISHU_ACTOR.identity);
  expect(options.assignees[0]?.identity).toEqual(TEST_FEISHU_ACTOR.identity);
});

it("requires a Feishu creator and refuses a different tenant's otherwise matching user_id", () => {
  const { database, actor, project, taskboard } = setup();
  const other: PrincipalView = {
    ...actor,
    identity: { kind: "feishu", tenantKey: "other-tenant", userId: "test-admin" },
  };
  seedFeishuTestActor(database, other);
  const command = CreateTaskCommandSchema.parse({
    projectId: project.id,
    title: "reject",
    assigneeIdentity: other.identity,
  });
  expect(() => taskboard.createTask(command, { actor, idempotencyKey: "reject-other" })).toThrow(
    "新任务负责人必须是当前发起人",
  );
  expect(() =>
    taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "service" }),
      {
        actor: { ...actor, identity: { kind: "service", serviceId: "local-admin" } },
        idempotencyKey: "reject-service",
      },
    ),
  ).toThrow("创建任务需要已登录用户");
  expect(database.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  expect(identityKey(other.identity)).not.toBe(identityKey(actor.identity));
});

it("refuses service comments and keeps comment ownership distinct across tenants", () => {
  const { database, actor, project, taskboard, workspace } = setup();
  const task = taskboard.createTask(
    CreateTaskCommandSchema.parse({ projectId: project.id, title: "comments" }),
    { actor, idempotencyKey: "comments-task" },
  ).task;
  const comment = workspace.createComment(
    task.id,
    { body: "Original author" },
    { actor, idempotencyKey: "comments-original" },
  ).data;
  const other = seedFeishuTestActor(database, {
    ...actor,
    role: "admin",
    identity: { kind: "feishu", tenantKey: "other-tenant", userId: "test-admin" },
  });
  database
    .prepare(
      "INSERT INTO project_members (project_id, identity_key, role, created_at) VALUES (?, ?, 'editor', ?)",
    )
    .run(project.id, identityKey(other.identity), "2026-09-09T00:00:00.000Z");
  expect(() =>
    workspace.updateComment(
      comment.id,
      { expectedVersion: comment.version, body: "Cross tenant edit" },
      { actor: other, idempotencyKey: "comments-other-edit" },
    ),
  ).toThrow("只能编辑或删除自己的评论");
  expect(() =>
    workspace.createComment(
      task.id,
      { body: "Service impersonation" },
      {
        actor: { ...actor, identity: { kind: "service", serviceId: "local-admin" } },
        idempotencyKey: "comments-service",
      },
    ),
  ).toThrow("发布评论需要已登录用户");
  expect(workspace.readTaskWorkspace(task.id, actor).comments.map((item) => item.body)).toEqual([
    "Original author",
  ]);
});

it("reads migrated historical service assignees and preserves them when editing unrelated fields", () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  runMigrations(
    database,
    CORE_MIGRATIONS.filter((migration) => migration.version <= 20),
  );
  const legacyService = "00000000-0000-4000-8000-000000000001";
  const projectId = "10000000-0000-4000-8000-000000000001";
  const taskId = "20000000-0000-4000-8000-000000000001";
  database
    .prepare(
      "INSERT INTO actors(id,tenant_key,open_id,name,role) VALUES (?,'development-tenant','development-user','Local','admin')",
    )
    .run(legacyService);
  database
    .prepare("INSERT INTO projects(id,project_key,name,created_by) VALUES (?,'HIST','History',?)")
    .run(projectId, legacyService);
  database
    .prepare(
      "INSERT INTO tasks(id,identifier,project_id,task_number,title,status,assignee_actor_id,creator_actor_id) VALUES (?,'HIST-001',?,1,'Historical task','todo',?,?)",
    )
    .run(taskId, projectId, legacyService, legacyService);
  runMigrations(database, CORE_MIGRATIONS);
  const actor = seedFeishuTestActor(database);
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  const taskboard = new Taskboard({ database, identityService });
  const historical = taskboard.readBoard(projectId, actor).tasks[0]!;
  expect(historical.assigneeIdentity).toEqual({ kind: "service", serviceId: "local-admin" });
  expect(historical.assignee?.identity).toEqual({ kind: "service", serviceId: "local-admin" });
  const edited = taskboard.updateTask(
    taskId,
    { expectedVersion: historical.version, title: "Updated title" },
    { actor, idempotencyKey: "historical-title-edit" },
  ).task;
  expect(edited.assigneeIdentity).toEqual({ kind: "service", serviceId: "local-admin" });
  expect(
    database.prepare("SELECT assignee_identity_key FROM tasks WHERE id = ?").pluck().get(taskId),
  ).toBe('["service","local-admin"]');
  expect(() =>
    UpdateTaskCommandSchema.parse({
      expectedVersion: edited.version,
      assigneeIdentity: historical.assigneeIdentity,
    }),
  ).toThrow();
  const assigned = taskboard.updateTask(
    taskId,
    {
      expectedVersion: edited.version,
      assigneeIdentity: { kind: "feishu", tenantKey: "test-tenant", userId: "test-admin" },
    },
    { actor, idempotencyKey: "historical-human-assignee" },
  ).task;
  expect(assigned.assigneeIdentity).toEqual(TEST_FEISHU_ACTOR.identity);
});
