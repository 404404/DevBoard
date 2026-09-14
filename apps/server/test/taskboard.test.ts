import { seedProjectMember } from "./helpers/project-member-fixture.js";
import { identityKey, type IdentityRef } from "@lark-codex/contracts";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import {
  ALL_PROJECT_ID,
  CreateTaskCommandSchema,
  TEMPORARY_PROJECT_ID,
  type PrincipalView,
  type CreateTaskCommand,
  type LocalDevelopmentContextView,
} from "@lark-codex/contracts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../src/app-error.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { ProjectSyncService } from "../src/modules/project-sync/index.js";
import { Taskboard, TaskWorkspace } from "../src/modules/taskboard/index.js";

const ADMIN_ACTOR: PrincipalView = {
  identity: TEST_FEISHU_ACTOR.identity,
  name: "本机管理员",
  avatarUrl: null,
  role: "admin",
};

const openDatabases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(options: { readonly temporaryProjectRoot?: string } = {}) {
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
  const project = administration.createProject({
    projectKey: "TASK",
    name: "任务项目",
    description: "",
  });
  const insertLabel = database.prepare(
    `INSERT INTO global_labels (
      id, name, sort_order, created_by_identity_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ["Alpha", "Beta", "Codex", "Hidden", "Mine", "Other", "Theirs", "Zulu", "后端", "安全"].forEach(
    (name, index) =>
      insertLabel.run(
        `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        name,
        index,
        identityKey(ADMIN_ACTOR.identity),
        "2026-09-03T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
      ),
  );
  const committedRevisions: number[] = [];
  const taskboard = new Taskboard({
    database,
    identityService,
    temporaryProjectRoot: options.temporaryProjectRoot,
    onRevisionCommitted: (revision) => committedRevisions.push(revision),
  });
  const workspace = new TaskWorkspace({ database, identityService, taskboard });
  return {
    database,
    identityService,
    administration,
    project,
    taskboard,
    workspace,
    committedRevisions,
  };
}

async function verifyFeishuFixture(database: SqliteDatabase, ref: IdentityRef) {
  const identity = database
    .prepare(
      "SELECT tenant_key AS tenantKey, user_id AS userId, name, avatar_url AS avatarUrl FROM identities WHERE identity_key = ?",
    )
    .get(identityKey(ref)) as {
    tenantKey: string;
    userId: string;
    name: string;
    avatarUrl: string | null;
  };
  await new IdentityService({
    database,
    sessionTtlSeconds: 300,
    provider: {
      kind: "feishu",
      async exchangeCode() {
        return { identity: ref, name: identity.name, avatarUrl: identity.avatarUrl };
      },
    },
  }).exchangeCode("fixture-code");
}

function createCommand(
  projectId: string,
  title: string,
  overrides: Partial<CreateTaskCommand> = {},
): CreateTaskCommand {
  return CreateTaskCommandSchema.parse({ projectId, title, ...overrides });
}

function mutation(idempotencyKey: string, actor: PrincipalView = ADMIN_ACTOR) {
  return { actor, idempotencyKey, requestId: `request-${idempotencyKey}` };
}

function syncCodexProjects(database: SqliteDatabase) {
  new ProjectSyncService({ database }).reconcile({
    schemaVersion: 1,
    generatedAt: "2026-09-05T08:00:00.000Z",
    projects: [
      {
        codexProjectId: "10000000-0000-4000-8000-0000000000a1",
        name: "排序项目 A",
        rootPaths: ["/Users/test/SortA"],
        position: 0,
      },
      {
        codexProjectId: "10000000-0000-4000-8000-0000000000b1",
        name: "排序项目 B",
        rootPaths: ["/Users/test/SortB"],
        position: 1,
      },
    ],
  });
  const rows = database
    .prepare(
      `SELECT id, name FROM projects
      WHERE codex_project_id IS NOT NULL ORDER BY sync_position`,
    )
    .all() as { id: string; name: string }[];
  const first = rows[0];
  const second = rows[1];
  if (!first || !second) throw new Error("Codex 排序项目 fixture 创建失败");
  return { first, second };
}

describe("Taskboard module", () => {
  it("offers only the logged-in Feishu assignee and shared temporary relation candidates", async () => {
    const { database, administration, project, taskboard } = setup();
    const viewer = seedProjectMember(database, project.id, {
      tenantKey: "tenant-options-viewer",
      userId: "options-viewer",
      name: "只读成员",
      avatarUrl: "https://example.com/viewer.png",
      actorRole: "member",
      projectRole: "viewer",
    });
    await verifyFeishuFixture(database, viewer.identity);
    const inactive = seedProjectMember(database, project.id, {
      tenantKey: "tenant-options-inactive",
      userId: "options-inactive",
      name: "失效成员",
      avatarUrl: "https://example.com/viewer.png",
      actorRole: "member",
      projectRole: "editor",
    });
    database
      .prepare("UPDATE identities SET active = 0 WHERE identity_key = ?")
      .run(identityKey(inactive.identity));
    const viewerActor: PrincipalView = {
      identity: viewer.identity,
      name: viewer.name,
      avatarUrl: "https://example.com/viewer.png",
      role: "member",
    };
    seedFeishuTestActor(database, viewerActor);
    const first = taskboard.createTask(
      createCommand(project.id, "候选任务一", { labels: ["Zulu", "Alpha"] }),
      mutation("creation-options-first"),
    ).task;
    const second = taskboard.createTask(
      createCommand(project.id, "候选任务二", { labels: ["Beta", "Alpha"] }),
      mutation("creation-options-second"),
    ).task;
    const archived = taskboard.createTask(
      createCommand(project.id, "已归档候选", { labels: ["Hidden"] }),
      mutation("creation-options-archived"),
    ).task;
    taskboard.archiveTask(
      archived.id,
      { expectedVersion: archived.version },
      mutation("creation-options-archive"),
    );
    const otherProject = administration.createProject({
      projectKey: "OTHER",
      name: "其他项目",
      description: "",
    });
    taskboard.createTask(
      createCommand(otherProject.id, "其他项目任务", { labels: ["Other"] }),
      mutation("creation-options-other"),
    );
    const developmentContexts = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        kind: "branch",
        label: "main",
        branch: "main",
        gitRef: "refs/heads/main",
        headSha: "a".repeat(40),
        worktreeRealpath: null,
        executable: false,
        active: true,
        scannedAt: "2026-09-02T08:00:00.000Z",
      },
    ] satisfies readonly LocalDevelopmentContextView[];
    let developmentContextReads = 0;
    const readDevelopmentContexts = () => {
      developmentContextReads += 1;
      return developmentContexts;
    };

    expect(
      taskboard.readTaskCreationOptions(project.id, viewerActor, readDevelopmentContexts),
    ).toEqual({
      projectId: project.id,
      currentIdentity: viewer.identity,
      assignees: [
        {
          identity: viewer.identity,
          name: "只读成员",
          avatarUrl: "https://example.com/viewer.png",
          actorRole: "member",
          projectRole: null,
        },
      ],
      labels: expect.arrayContaining([
        expect.objectContaining({ name: "Alpha", sortOrder: 0 }),
        expect.objectContaining({ name: "安全", sortOrder: 9 }),
      ]),
      developmentContexts,
      defaultDevelopmentContext: { id: null, label: "无", branch: null },
      relationCandidates: [
        { id: first.id, identifier: "TASK-001", title: "候选任务一" },
        { id: second.id, identifier: "TASK-002", title: "候选任务二" },
      ],
      attachmentMaxBytes: 25 * 1024 * 1024,
    });
    expect(developmentContextReads).toBe(1);

    expect(() =>
      taskboard.createTask(
        createCommand(project.id, "不能指派给开发身份", {
          assigneeIdentity: { kind: "service", serviceId: "local-admin" } as never,
        }),
        mutation("reject-development-assignee"),
      ),
    ).toThrow();

    const outsider = seedProjectMember(database, otherProject.id, {
      tenantKey: "tenant-options-outsider",
      userId: "options-outsider",
      name: "无权限成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const outsiderActor: PrincipalView = {
      identity: outsider.identity,
      name: outsider.name,
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, outsiderActor);
    developmentContextReads = 0;
    expect(
      taskboard.readTaskCreationOptions(project.id, outsiderActor, readDevelopmentContexts),
    ).toMatchObject({
      currentIdentity: outsider.identity,
      assignees: [{ identity: outsider.identity }],
    });
    expect(developmentContextReads).toBe(1);

    const visiblePrivate = taskboard.createTask(
      createCommand(TEMPORARY_PROJECT_ID, "当前用户的临时候选", { labels: ["Mine"] }),
      mutation("creation-options-private-visible", viewerActor),
    ).task;
    const otherTemporary = taskboard.createTask(
      createCommand(TEMPORARY_PROJECT_ID, "其他用户的临时候选", { labels: ["Theirs"] }),
      mutation("creation-options-private-hidden", outsiderActor),
    ).task;
    expect(
      taskboard.readTaskCreationOptions(TEMPORARY_PROJECT_ID, viewerActor, () => []),
    ).toMatchObject({
      currentIdentity: viewer.identity,
      labels: expect.arrayContaining([expect.objectContaining({ name: "Mine" })]),
      relationCandidates: [
        {
          id: visiblePrivate.id,
          identifier: visiblePrivate.identifier,
          title: "当前用户的临时候选",
        },
        {
          id: otherTemporary.id,
          identifier: otherTemporary.identifier,
          title: "其他用户的临时候选",
        },
      ],
    });

    let allContextReads = 0;
    expect(() =>
      taskboard.readTaskCreationOptions(ALL_PROJECT_ID, ADMIN_ACTOR, () => {
        allContextReads += 1;
        return [];
      }),
    ).toThrow(/实际项目/);
    expect(allContextReads).toBe(0);

    const sync = new ProjectSyncService({ database });
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-02T08:01:00.000Z",
      projects: [
        {
          codexProjectId: "10000000-0000-4000-8000-000000000099",
          name: "Codex 创建选项项目",
          rootPaths: ["/Users/test/CodexOptions"],
          position: 0,
        },
      ],
    });
    const codexProjectId = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .pluck()
      .get("10000000-0000-4000-8000-000000000099") as string;
    const codexTask = taskboard.createTask(
      createCommand(codexProjectId, "Codex 候选任务", { labels: ["Codex"] }),
      mutation("creation-options-codex"),
    ).task;
    let codexContextReads = 0;
    expect(
      taskboard.readTaskCreationOptions(codexProjectId, ADMIN_ACTOR, () => {
        codexContextReads += 1;
        return [];
      }),
    ).toMatchObject({
      labels: expect.arrayContaining([expect.objectContaining({ name: "Codex" })]),
      relationCandidates: [
        {
          id: codexTask.id,
          identifier: codexTask.identifier,
          title: "Codex 候选任务",
        },
      ],
    });
    expect(codexContextReads).toBe(1);

    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-02T08:02:00.000Z",
      projects: [],
    });
    codexContextReads = 0;
    expect(() =>
      taskboard.readTaskCreationOptions(codexProjectId, ADMIN_ACTOR, () => {
        codexContextReads += 1;
        return [];
      }),
    ).toThrowError(AppError);
    expect(codexContextReads).toBe(0);
  });

  it("rejects labels outside the global catalog on create and update", () => {
    const { project, taskboard } = setup();

    expect(() =>
      taskboard.createTask(
        createCommand(project.id, "未知标签任务", { labels: ["不存在"] }),
        mutation("unknown-label-create"),
      ),
    ).toThrow(/全局标签/);

    const created = taskboard.createTask(
      createCommand(project.id, "已知标签任务", { labels: ["Alpha"] }),
      mutation("known-label-create"),
    ).task;
    expect(() =>
      taskboard.updateTask(
        created.id,
        { expectedVersion: created.version, labels: ["不存在"] },
        mutation("unknown-label-update"),
      ),
    ).toThrow(/全局标签/);
  });

  it("shares native temporary tasks between verified users while allowing only self-assignment", async () => {
    const { database, project, taskboard } = setup();
    const creator = seedProjectMember(database, project.id, {
      tenantKey: "tenant-temporary-creator",
      userId: "temporary-creator",
      name: "临时任务创建者",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    const creatorActor: PrincipalView = {
      identity: creator.identity,
      name: creator.name,
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, creatorActor);
    const other = seedProjectMember(database, project.id, {
      tenantKey: "tenant-temporary-other",
      userId: "temporary-other",
      name: "其他成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    const otherActor: PrincipalView = {
      identity: other.identity,
      name: other.name,
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, otherActor);

    const created = taskboard.createTask(
      createCommand(TEMPORARY_PROJECT_ID, "共享临时任务"),
      mutation("temporary-native-create", creatorActor),
    );

    expect(created.task).toMatchObject({
      projectId: TEMPORARY_PROJECT_ID,
      projectName: "临时项目",
      originProjectName: null,
      codexThreadState: "none",
      permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
    });
    expect(taskboard.readBoard(TEMPORARY_PROJECT_ID, creatorActor).tasks).toHaveLength(1);
    expect(taskboard.readBoard(TEMPORARY_PROJECT_ID, otherActor).tasks).toHaveLength(1);

    await verifyFeishuFixture(database, otherActor.identity);
    const assignedTask = taskboard.createTask(
      createCommand(TEMPORARY_PROJECT_ID, "指派的临时任务"),
      mutation("temporary-assigned-create", creatorActor),
    );
    expect(() =>
      taskboard.updateTask(
        assignedTask.task.id,
        { expectedVersion: assignedTask.task.version, assigneeIdentity: other.identity },
        mutation("temporary-reject-other-assignee", creatorActor),
      ),
    ).toThrowError(AppError);
    expect(taskboard.readTask(assignedTask.task.id, creatorActor)).toMatchObject({
      version: assignedTask.task.version,
      assigneeIdentity: creator.identity,
    });
    const assigned = taskboard.updateTask(
      assignedTask.task.id,
      { expectedVersion: assignedTask.task.version, assigneeIdentity: other.identity },
      mutation("temporary-assigned-update", otherActor),
    );
    expect(assigned.task.assigneeIdentity).toEqual(other.identity);
    expect(taskboard.readTask(created.task.id, otherActor).assigneeIdentity).toEqual(
      creator.identity,
    );
    expect(taskboard.readBoard(TEMPORARY_PROJECT_ID, creatorActor).tasks).toHaveLength(2);
    expect(taskboard.readBoard(TEMPORARY_PROJECT_ID, otherActor).tasks).toHaveLength(2);
    expect(taskboard.readTask(assigned.task.id, otherActor).permissions).toMatchObject({
      canRead: true,
      canWrite: true,
      canExecute: true,
    });
  });

  it("requires related temporary tasks to be reassigned as their origin group", () => {
    const { database, project, taskboard } = setup();
    const first = taskboard.createTask(
      createCommand(project.id, "关系任务一"),
      mutation("reassign-related-first"),
    ).task;
    const second = taskboard.createTask(
      createCommand(project.id, "关系任务二"),
      mutation("reassign-related-second"),
    ).task;
    database
      .prepare(
        `INSERT INTO task_relations (id, project_id, type, source_task_id, target_task_id)
        VALUES (?, ?, 'related', ?, ?)`,
      )
      .run(crypto.randomUUID(), project.id, first.id, second.id);
    database
      .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
      .run("/Users/test/Source", project.id);
    const sync = new ProjectSyncService({ database });
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "来源项目",
          rootPaths: ["/Users/test/Source"],
          position: 0,
        },
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "目标项目",
          rootPaths: ["/Users/test/Target"],
          position: 1,
        },
      ],
    });
    const targetId = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .pluck()
      .get("22222222-2222-4222-8222-222222222222") as string;
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:01:00.000Z",
      projects: [
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "目标项目",
          rootPaths: ["/Users/test/Target"],
          position: 0,
        },
      ],
    });
    const temporaryFirst = taskboard.readTask(first.id, ADMIN_ACTOR);

    expect(() =>
      taskboard.reassignTask(
        first.id,
        { expectedVersion: temporaryFirst.version, targetProjectId: targetId, mode: "single" },
        mutation("reassign-related-single"),
      ),
    ).toThrow(/整组/);
    const moved = taskboard.reassignTask(
      first.id,
      {
        expectedVersion: temporaryFirst.version,
        targetProjectId: targetId,
        mode: "origin_group",
      },
      mutation("reassign-related-group"),
    );
    expect(moved.task.projectId).toBe(targetId);
    expect(
      database
        .prepare("SELECT DISTINCT project_id FROM tasks WHERE id IN (?, ?)")
        .pluck()
        .all(first.id, second.id),
    ).toEqual([targetId]);
    expect(database.prepare("SELECT project_id FROM task_relations").pluck().get()).toBe(targetId);
    expect(database.prepare("SELECT count(*) FROM project_orphaned_tasks").pluck().get()).toBe(0);
  });

  it("rejects reassignment when the primary Thread cwd is outside target roots", () => {
    const { database, project, taskboard } = setup();
    const task = taskboard.createTask(
      createCommand(project.id, "带 Thread 的任务"),
      mutation("reassign-thread-create"),
    ).task;
    database
      .prepare(
        `INSERT INTO task_threads (id, task_id, thread_id, cwd, is_primary)
        VALUES (?, ?, 'thread-source', '/Users/test/Source/worktree', 1)`,
      )
      .run(crypto.randomUUID(), task.id);
    database
      .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
      .run("/Users/test/Source", project.id);
    const sync = new ProjectSyncService({ database });
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "来源项目",
          rootPaths: ["/Users/test/Source"],
          position: 0,
        },
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "目标项目",
          rootPaths: ["/Users/test/Target"],
          position: 1,
        },
      ],
    });
    const targetId = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .pluck()
      .get("22222222-2222-4222-8222-222222222222") as string;
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:01:00.000Z",
      projects: [
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "目标项目",
          rootPaths: ["/Users/test/Target"],
          position: 0,
        },
      ],
    });
    const temporary = taskboard.readTask(task.id, ADMIN_ACTOR);

    expect(() =>
      taskboard.reassignTask(
        task.id,
        { expectedVersion: temporary.version, targetProjectId: targetId, mode: "single" },
        mutation("reassign-thread-mismatch"),
      ),
    ).toThrow(/Thread 目录/);
  });

  it("allows reassignment when the Thread cwd and target root resolve to the same directory", () => {
    const { database, project, taskboard } = setup();
    const directory = mkdtempSync(join(tmpdir(), "lark-codex-reassign-"));
    temporaryDirectories.push(directory);
    const sourceRoot = join(directory, "source");
    const targetAlias = join(directory, "target-alias");
    mkdirSync(sourceRoot);
    symlinkSync(sourceRoot, targetAlias, "dir");

    const task = taskboard.createTask(
      createCommand(project.id, "同目录新项目任务"),
      mutation("reassign-same-directory-create"),
    ).task;
    database
      .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
      .run(sourceRoot, project.id);
    const sync = new ProjectSyncService({ database });
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "来源项目",
          rootPaths: [sourceRoot],
          position: 0,
        },
      ],
    });
    database
      .prepare(
        `INSERT INTO task_threads (id, task_id, thread_id, cwd, is_primary)
        VALUES (?, ?, 'thread-same-directory', ?, 1)`,
      )
      .run(crypto.randomUUID(), task.id, realpathSync(sourceRoot));
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:01:00.000Z",
      projects: [],
    });
    sync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:02:00.000Z",
      projects: [
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "同目录新项目",
          rootPaths: [targetAlias],
          position: 0,
        },
      ],
    });
    const targetId = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .pluck()
      .get("22222222-2222-4222-8222-222222222222") as string;
    const temporary = taskboard.readTask(task.id, ADMIN_ACTOR);

    const moved = taskboard.reassignTask(
      task.id,
      { expectedVersion: temporary.version, targetProjectId: targetId, mode: "single" },
      mutation("reassign-same-directory"),
    );

    expect(moved.task.projectId).toBe(targetId);
  });

  it("persists all task fields, assigns monotonic numbers and replays idempotent creates", async () => {
    const { database, project, taskboard, committedRevisions } = setup();
    const member = seedProjectMember(database, project.id, {
      tenantKey: "tenant-1",
      userId: "assignee-1",
      name: "负责人",
      avatarUrl: "https://example.com/assignee.png",
      actorRole: "member",
      projectRole: "editor",
    });
    await verifyFeishuFixture(database, member.identity);
    const contextId = "10000000-0000-4000-8000-000000000001";
    database
      .prepare(
        `INSERT INTO project_development_contexts (
          id, project_id, context_key, kind, label, branch, git_ref, head_sha,
          worktree_realpath, executable, active, scanned_at
        ) VALUES (?, ?, ?, 'branch', 'main', 'main', 'refs/heads/main', ?, NULL, 0, 1, ?)`,
      )
      .run(
        contextId,
        project.id,
        "branch:refs/heads/main",
        "a".repeat(40),
        "2026-08-30T12:00:00.000Z",
      );
    const command = createCommand(project.id, "完整字段任务", {
      description: "任务描述",
      status: "todo",
      priority: "high",
      labels: ["后端", "安全"],
      assigneeIdentity: member.identity,
      startAt: "2026-08-30T08:00:00+08:00",
      dueAt: "2026-08-31T08:00:00+08:00",
      recurrence: { frequency: "weekly", interval: 1 },
      developmentContextId: contextId,
      links: ["https://example.com/spec", "https://example.com/design"],
    });

    const memberActor: PrincipalView = {
      identity: member.identity,
      name: member.name,
      avatarUrl: "https://example.com/assignee.png",
      role: "member",
    };
    const first = taskboard.createTask(command, mutation("create-full-0001", memberActor));
    const replay = taskboard.createTask(command, mutation("create-full-0001", memberActor));

    expect(replay).toEqual(first);
    expect(committedRevisions).toEqual([first.revision]);
    expect(first.task).toMatchObject({
      identifier: "TASK-001",
      taskNumber: 1,
      title: "完整字段任务",
      description: "任务描述",
      status: "todo",
      priority: "high",
      labels: ["后端", "安全"],
      assigneeIdentity: member.identity,
      assignee: {
        identity: member.identity,
        name: "负责人",
        avatarUrl: "https://example.com/assignee.png",
      },
      startAt: "2026-08-30T00:00:00.000Z",
      dueAt: "2026-08-31T00:00:00.000Z",
      recurrence: { frequency: "weekly", interval: 1 },
      developmentContextId: contextId,
      links: ["https://example.com/spec", "https://example.com/design"],
      version: 1,
    });
    const withUpdatedLinks = taskboard.updateTask(
      first.task.id,
      {
        expectedVersion: first.task.version,
        links: ["https://example.com/review"],
      },
      mutation("update-links-0002"),
    );
    expect(withUpdatedLinks.task.links).toEqual(["https://example.com/review"]);
    expect(database.prepare("SELECT count(*) FROM tasks").pluck().get()).toBe(1);
    expect(
      database
        .prepare("SELECT next_task_number FROM projects WHERE id = ?")
        .pluck()
        .get(project.id),
    ).toBe(2);
    expect(() =>
      taskboard.createTask(
        createCommand(project.id, "复用幂等键的不同任务"),
        mutation("create-full-0001", memberActor),
      ),
    ).toThrowError(AppError);

    const second = taskboard.createTask(
      createCommand(project.id, "第二个任务"),
      mutation("create-second-0002"),
    );
    const archived = taskboard.archiveTask(
      second.task.id,
      { expectedVersion: second.task.version },
      mutation("archive-second-0003"),
    );
    expect(archived.task.archivedAt).not.toBeNull();
    const third = taskboard.createTask(
      createCommand(project.id, "第三个任务"),
      mutation("create-third-0004"),
    );
    expect(third.task.identifier).toBe("TASK-003");
  });

  it("creates initial task relations atomically and exposes the correct direction on both sides", () => {
    const { database, project, taskboard, workspace } = setup();
    const parent = taskboard.createTask(
      createCommand(project.id, "候选父任务"),
      mutation("initial-parent-0001"),
    ).task;
    const child = taskboard.createTask(
      createCommand(project.id, "候选子任务"),
      mutation("initial-child-0002"),
    ).task;
    const relatedFirst = taskboard.createTask(
      createCommand(project.id, "关联任务一"),
      mutation("initial-related-0003"),
    ).task;
    const relatedSecond = taskboard.createTask(
      createCommand(project.id, "关联任务二"),
      mutation("initial-related-0004"),
    ).task;

    const created = taskboard.createTask(
      createCommand(project.id, "一次创建完整关系", {
        links: ["https://example.com/spec", "https://example.com/issue"],
        initialRelations: {
          parentTaskId: parent.id,
          childTaskId: child.id,
          relatedTaskIds: [relatedSecond.id, relatedFirst.id],
        },
      }),
      mutation("initial-relations-create-0005"),
    );

    expect(created.task.links).toEqual(["https://example.com/spec", "https://example.com/issue"]);
    expect(
      workspace
        .readTaskWorkspace(created.task.id, ADMIN_ACTOR)
        .relations.map(({ relationType, targetTaskId }) => ({ relationType, targetTaskId })),
    ).toEqual(
      expect.arrayContaining([
        { relationType: "parent", targetTaskId: parent.id },
        { relationType: "child", targetTaskId: child.id },
        { relationType: "related", targetTaskId: relatedFirst.id },
        { relationType: "related", targetTaskId: relatedSecond.id },
      ]),
    );
    expect(workspace.readTaskWorkspace(parent.id, ADMIN_ACTOR).relations).toEqual([
      expect.objectContaining({ relationType: "child", targetTaskId: created.task.id }),
    ]);
    expect(workspace.readTaskWorkspace(child.id, ADMIN_ACTOR).relations).toEqual([
      expect.objectContaining({ relationType: "parent", targetTaskId: created.task.id }),
    ]);
    expect(workspace.readTaskWorkspace(relatedFirst.id, ADMIN_ACTOR).relations).toEqual([
      expect.objectContaining({ relationType: "related", targetTaskId: created.task.id }),
    ]);
    expect(workspace.readTaskWorkspace(relatedSecond.id, ADMIN_ACTOR).relations).toEqual([
      expect.objectContaining({ relationType: "related", targetTaskId: created.task.id }),
    ]);
    const relationEvents = database
      .prepare(
        `SELECT safe_payload_json FROM change_events
        WHERE event_type = 'relation.created' ORDER BY revision`,
      )
      .pluck()
      .all()
      .map((payload) => JSON.parse(payload as string) as Record<string, unknown>);
    expect(relationEvents).toHaveLength(4);
    expect(relationEvents).toEqual(
      expect.arrayContaining(
        [parent.id, child.id, relatedFirst.id, relatedSecond.id].map((relatedTaskId) =>
          expect.objectContaining({ taskId: created.task.id, relatedTaskId }),
        ),
      ),
    );
    expect(created.revision).toBe(
      database.prepare("SELECT max(revision) FROM change_events").pluck().get(),
    );
    const relationActivities = database
      .prepare(
        `SELECT changes_json FROM activities
        WHERE task_id = ? AND kind = 'relation.created' ORDER BY rowid`,
      )
      .pluck()
      .all(created.task.id)
      .map((changes) => JSON.parse(changes as string) as Record<string, unknown>);
    expect(relationActivities).toHaveLength(4);
    expect(relationActivities.every((changes) => changes.initial === true)).toBe(true);
  });

  it("rolls back the entire create when an initial relation is invalid or violates uniqueness", () => {
    const { database, administration, project, taskboard, workspace } = setup();
    const otherProject = administration.createProject({
      projectKey: "OTHER",
      name: "其他项目",
      description: "",
    });
    const validParent = taskboard.createTask(
      createCommand(project.id, "可用父任务"),
      mutation("atomic-valid-parent"),
    ).task;
    const occupiedParent = taskboard.createTask(
      createCommand(project.id, "已有子任务的父任务"),
      mutation("atomic-occupied-parent"),
    ).task;
    const occupiedChild = taskboard.createTask(
      createCommand(project.id, "已有父任务的子任务"),
      mutation("atomic-occupied-child"),
    ).task;
    workspace.createRelation(
      occupiedParent.id,
      { relationType: "child", targetTaskId: occupiedChild.id },
      mutation("atomic-existing-relation"),
    );
    const outsider = taskboard.createTask(
      createCommand(otherProject.id, "跨项目候选"),
      mutation("atomic-outsider"),
    ).task;
    const archivedTarget = taskboard.createTask(
      createCommand(project.id, "已归档候选"),
      mutation("atomic-archived-target"),
    ).task;
    taskboard.archiveTask(
      archivedTarget.id,
      { expectedVersion: archivedTarget.version },
      mutation("atomic-archive-target"),
    );

    const snapshot = () => ({
      tasks: database.prepare("SELECT count(*) FROM tasks").pluck().get(),
      relations: database.prepare("SELECT count(*) FROM task_relations").pluck().get(),
      activities: database.prepare("SELECT count(*) FROM activities").pluck().get(),
      changes: database.prepare("SELECT count(*) FROM change_events").pluck().get(),
      audits: database.prepare("SELECT count(*) FROM audit_events").pluck().get(),
      idempotency: database.prepare("SELECT count(*) FROM request_idempotency").pluck().get(),
      nextTaskNumber: database
        .prepare("SELECT next_task_number FROM projects WHERE id = ?")
        .pluck()
        .get(project.id),
    });
    const expectAtomicFailure = (
      idempotencyKey: string,
      command: CreateTaskCommand,
      message: RegExp,
    ) => {
      const before = snapshot();
      expect(() => taskboard.createTask(command, mutation(idempotencyKey))).toThrow(message);
      expect(snapshot()).toEqual(before);
    };

    expectAtomicFailure(
      "atomic-cross-project",
      createCommand(project.id, "跨项目关系", {
        initialRelations: {
          parentTaskId: null,
          childTaskId: null,
          relatedTaskIds: [outsider.id],
        },
      }),
      /同一项目/,
    );
    expectAtomicFailure(
      "atomic-same-parent-child",
      {
        ...createCommand(project.id, "父子指向同一任务"),
        initialRelations: {
          parentTaskId: validParent.id,
          childTaskId: validParent.id,
          relatedTaskIds: [],
        },
      },
      /同一任务|循环/,
    );
    expectAtomicFailure(
      "atomic-archived-relation",
      createCommand(project.id, "关联已归档任务", {
        initialRelations: {
          parentTaskId: null,
          childTaskId: null,
          relatedTaskIds: [archivedTarget.id],
        },
      }),
      /已归档/,
    );
    expectAtomicFailure(
      "atomic-partial-relation",
      createCommand(project.id, "插入部分关系后整体失败", {
        initialRelations: {
          parentTaskId: validParent.id,
          childTaskId: occupiedChild.id,
          relatedTaskIds: [],
        },
      }),
      /子任务已有父任务/,
    );
    expectAtomicFailure(
      "atomic-parent-cycle",
      createCommand(project.id, "创建时形成父子循环", {
        initialRelations: {
          parentTaskId: occupiedChild.id,
          childTaskId: occupiedParent.id,
          relatedTaskIds: [],
        },
      }),
      /循环/,
    );
  });

  it("rejects an unverified actor linking an initial relation without consuming a task number", () => {
    const { database, project, taskboard } = setup();
    const firstMember = seedProjectMember(database, project.id, {
      tenantKey: "tenant-private-first",
      userId: "private-first",
      name: "第一位成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    const secondMember = seedProjectMember(database, project.id, {
      tenantKey: "tenant-private-second",
      userId: "private-second",
      name: "第二位成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    const firstActor: PrincipalView = {
      identity: firstMember.identity,
      name: firstMember.name,
      avatarUrl: null,
      role: "member",
    };
    const secondActor: PrincipalView = {
      identity: secondMember.identity,
      name: secondMember.name,
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, secondActor);
    const privateTarget = taskboard.createTask(
      createCommand(TEMPORARY_PROJECT_ID, "另一位成员的私人任务"),
      mutation("private-target", secondActor),
    ).task;
    const before = {
      tasks: database.prepare("SELECT count(*) FROM tasks").pluck().get(),
      relations: database.prepare("SELECT count(*) FROM task_relations").pluck().get(),
      changes: database.prepare("SELECT count(*) FROM change_events").pluck().get(),
      nextTaskNumber: database
        .prepare("SELECT next_task_number FROM projects WHERE id = ?")
        .pluck()
        .get(TEMPORARY_PROJECT_ID),
    };

    expect(() =>
      taskboard.createTask(
        createCommand(TEMPORARY_PROJECT_ID, "不应越权关联", {
          initialRelations: {
            parentTaskId: null,
            childTaskId: null,
            relatedTaskIds: [privateTarget.id],
          },
        }),
        mutation("private-unread-relation", firstActor),
      ),
    ).toThrowError(AppError);
    expect({
      tasks: database.prepare("SELECT count(*) FROM tasks").pluck().get(),
      relations: database.prepare("SELECT count(*) FROM task_relations").pluck().get(),
      changes: database.prepare("SELECT count(*) FROM change_events").pluck().get(),
      nextTaskNumber: database
        .prepare("SELECT next_task_number FROM projects WHERE id = ?")
        .pluck()
        .get(TEMPORARY_PROJECT_ID),
    }).toEqual(before);
  });

  it("moves by anchors while keeping version, activity and revision changes atomic", () => {
    const { database, project, taskboard } = setup();
    const first = taskboard.createTask(
      createCommand(project.id, "第一个", { status: "todo" }),
      mutation("create-order-0001"),
    );
    taskboard.createTask(
      createCommand(project.id, "第二个", { status: "todo" }),
      mutation("create-order-0002"),
    );
    const third = taskboard.createTask(
      createCommand(project.id, "第三个", { status: "todo" }),
      mutation("create-order-0003"),
    );

    const moved = taskboard.moveTask(
      third.task.id,
      {
        expectedVersion: third.task.version,
        targetStatus: "todo",
        beforeTaskId: first.task.id,
      },
      mutation("move-order-0004"),
    );
    const board = taskboard.readBoard(project.id, ADMIN_ACTOR);

    expect(board.tasks.map((task) => task.title)).toEqual(["第三个", "第一个", "第二个"]);
    expect(moved.task.version).toBe(2);
    expect(moved.task.sortOrder).toBeLessThan(first.task.sortOrder);
    expect(database.prepare("SELECT count(*) FROM activities").pluck().get()).toBe(4);
    expect(database.prepare("SELECT count(*) FROM change_events").pluck().get()).toBe(4);
    expect(
      JSON.parse(
        database
          .prepare("SELECT changes_json FROM activities WHERE kind = 'task.moved'")
          .pluck()
          .get() as string,
      ),
    ).toMatchObject({ status: { from: "todo", to: "todo" } });

    const statusMoved = taskboard.moveTask(
      first.task.id,
      { expectedVersion: first.task.version, targetStatus: "in_progress" },
      mutation("move-status-0005"),
    );
    expect(statusMoved.task).toMatchObject({ status: "in_progress", version: 2 });
    expect(database.prepare("SELECT count(*) FROM activities").pluck().get()).toBe(5);
    expect(database.prepare("SELECT count(*) FROM change_events").pluck().get()).toBe(5);

    const restored = taskboard.restoreTask(
      taskboard.archiveTask(
        moved.task.id,
        { expectedVersion: moved.task.version },
        mutation("archive-order-0006"),
      ).task.id,
      { expectedVersion: 3 },
      mutation("restore-order-0007"),
    );
    expect(restored.task).toMatchObject({ version: 4, archivedAt: null });
  });

  it("persists a mixed all-project order while preserving each project's relative order", () => {
    const { database, taskboard } = setup();
    const projects = syncCodexProjects(database);
    const a1 = taskboard.createTask(
      createCommand(projects.first.id, "A1", { status: "todo" }),
      mutation("global-order-a1"),
    ).task;
    const a2 = taskboard.createTask(
      createCommand(projects.first.id, "A2", { status: "todo" }),
      mutation("global-order-a2"),
    ).task;
    const b1 = taskboard.createTask(
      createCommand(projects.second.id, "B1", { status: "todo" }),
      mutation("global-order-b1"),
    ).task;
    const b2 = taskboard.createTask(
      createCommand(projects.second.id, "B2", { status: "todo" }),
      mutation("global-order-b2"),
    ).task;
    database.prepare("UPDATE tasks SET sort_order = 1024 WHERE id IN (?, ?)").run(a1.id, b1.id);
    database.prepare("UPDATE tasks SET sort_order = 2048 WHERE id = ?").run(a2.id);
    database.prepare("UPDATE tasks SET sort_order = 3072 WHERE id = ?").run(b2.id);

    const globallyMoved = taskboard.moveTask(
      b1.id,
      {
        expectedVersion: b1.version,
        targetStatus: "todo",
        boardProjectId: ALL_PROJECT_ID,
        beforeTaskId: a2.id,
        afterTaskId: a1.id,
      },
      mutation("global-order-mix"),
    ).task;

    expect(
      taskboard
        .readBoard(ALL_PROJECT_ID, ADMIN_ACTOR)
        .tasks.filter((task) => task.status === "todo")
        .map((task) => task.id),
    ).toEqual([a1.id, b1.id, a2.id, b2.id]);
    expect(
      taskboard.readBoard(projects.first.id, ADMIN_ACTOR).tasks.map((task) => task.id),
    ).toEqual([a1.id, a2.id]);
    expect(
      taskboard.readBoard(projects.second.id, ADMIN_ACTOR).tasks.map((task) => task.id),
    ).toEqual([b1.id, b2.id]);
    expect(globallyMoved.projectId).toBe(projects.second.id);

    taskboard.moveTask(
      b2.id,
      {
        expectedVersion: b2.version,
        targetStatus: "todo",
        boardProjectId: projects.second.id,
        beforeTaskId: b1.id,
      },
      mutation("global-order-single-project"),
    );
    taskboard.moveTask(
      a2.id,
      {
        expectedVersion: a2.version,
        targetStatus: "todo",
        boardProjectId: ALL_PROJECT_ID,
        afterTaskId: b1.id,
      },
      mutation("global-order-mix-again"),
    );

    const allAgain = taskboard
      .readBoard(ALL_PROJECT_ID, ADMIN_ACTOR)
      .tasks.filter((task) => task.status === "todo");
    expect(
      allAgain.filter((task) => task.projectId === projects.first.id).map((task) => task.id),
    ).toEqual([a1.id, a2.id]);
    expect(
      allAgain.filter((task) => task.projectId === projects.second.id).map((task) => task.id),
    ).toEqual([b2.id, b1.id]);
    expect(
      taskboard.readBoard(projects.first.id, ADMIN_ACTOR).tasks.map((task) => task.id),
    ).toEqual([a1.id, a2.id]);
    expect(
      taskboard.readBoard(projects.second.id, ADMIN_ACTOR).tasks.map((task) => task.id),
    ).toEqual([b2.id, b1.id]);
  });

  it("allows verified users to reorder across legacy viewer projects without changing ownership", () => {
    const { database, taskboard } = setup();
    const projects = syncCodexProjects(database);
    const editor = seedProjectMember(database, projects.first.id, {
      tenantKey: "tenant-sort-editor",
      userId: "sort-editor",
      name: "排序编辑者",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    seedProjectMember(database, projects.second.id, {
      tenantKey: "tenant-sort-editor",
      userId: "sort-editor",
      name: "排序编辑者",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const actor: PrincipalView = {
      identity: editor.identity,
      name: editor.name,
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, actor);
    const source = taskboard.createTask(
      createCommand(projects.first.id, "可写源任务", { status: "todo" }),
      mutation("readable-anchor-source"),
    ).task;
    const anchor = taskboard.createTask(
      createCommand(projects.second.id, "只读锚点", { status: "todo" }),
      mutation("readable-anchor-target"),
    ).task;

    const moved = taskboard.moveTask(
      source.id,
      {
        expectedVersion: source.version,
        targetStatus: "todo",
        boardProjectId: ALL_PROJECT_ID,
        beforeTaskId: anchor.id,
      },
      mutation("readable-anchor-move", actor),
    ).task;

    expect(moved.projectId).toBe(projects.first.id);
    expect(taskboard.readTask(anchor.id, actor).version).toBe(anchor.version);
    expect(taskboard.readBoard(ALL_PROJECT_ID, actor).tasks.map((task) => task.id)).toEqual([
      source.id,
      anchor.id,
    ]);

    const anchorMoved = taskboard.moveTask(
      anchor.id,
      {
        expectedVersion: anchor.version,
        targetStatus: "todo",
        boardProjectId: ALL_PROJECT_ID,
        beforeTaskId: source.id,
      },
      mutation("readable-anchor-reorder-source", actor),
    ).task;
    expect(anchorMoved).toMatchObject({
      projectId: projects.second.id,
      assigneeIdentity: anchor.assigneeIdentity,
      version: anchor.version + 1,
    });
    expect(taskboard.readTask(source.id, actor)).toMatchObject({
      projectId: projects.first.id,
      assigneeIdentity: source.assigneeIdentity,
      version: moved.version,
    });
    expect(taskboard.readBoard(ALL_PROJECT_ID, actor).tasks.map((task) => task.id)).toEqual([
      anchor.id,
      source.id,
    ]);
  });

  it("rebalances equal adjacent ranks without touching archived tasks or semantic fields", () => {
    const { database, taskboard } = setup();
    const projects = syncCodexProjects(database);
    const editor = seedProjectMember(database, projects.first.id, {
      tenantKey: "tenant-equal-rank",
      userId: "equal-rank",
      name: "并列排序者",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    seedProjectMember(database, projects.second.id, {
      tenantKey: "tenant-equal-rank",
      userId: "equal-rank",
      name: "并列排序者",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const actor: PrincipalView = {
      identity: editor.identity,
      name: editor.name,
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, actor);
    const source = taskboard.createTask(
      createCommand(projects.first.id, "待插入任务", { status: "todo" }),
      mutation("equal-rank-source"),
    ).task;
    const firstAnchor = taskboard.createTask(
      createCommand(projects.second.id, "并列锚点一", { status: "todo" }),
      mutation("equal-rank-first-anchor"),
    ).task;
    const secondAnchor = taskboard.createTask(
      createCommand(projects.second.id, "并列锚点二", { status: "todo" }),
      mutation("equal-rank-second-anchor"),
    ).task;
    const hidden = taskboard.createTask(
      createCommand(TEMPORARY_PROJECT_ID, "已归档任务", { status: "todo" }),
      mutation("equal-rank-hidden"),
    ).task;
    taskboard.archiveTask(
      hidden.id,
      { expectedVersion: hidden.version },
      mutation("equal-rank-archive"),
    );
    database
      .prepare("UPDATE tasks SET sort_order = 1024 WHERE id IN (?, ?)")
      .run(firstAnchor.id, secondAnchor.id);
    const updatedSource = taskboard.updateTask(
      source.id,
      { expectedVersion: source.version, priority: "urgent" },
      mutation("equal-rank-source-update"),
    ).task;
    const hiddenBefore = database.prepare("SELECT * FROM tasks WHERE id = ?").get(hidden.id);
    const tasksBeforeConflict = database.prepare("SELECT * FROM tasks ORDER BY id").all();

    expect(() =>
      taskboard.moveTask(
        source.id,
        {
          expectedVersion: source.version,
          targetStatus: "todo",
          boardProjectId: ALL_PROJECT_ID,
          beforeTaskId: secondAnchor.id,
          afterTaskId: firstAnchor.id,
        },
        mutation("equal-rank-stale-move", actor),
      ),
    ).toThrow(/版本已变化/);
    expect(database.prepare("SELECT * FROM tasks ORDER BY id").all()).toEqual(tasksBeforeConflict);

    const moved = taskboard.moveTask(
      source.id,
      {
        expectedVersion: updatedSource.version,
        targetStatus: "todo",
        boardProjectId: ALL_PROJECT_ID,
        beforeTaskId: secondAnchor.id,
        afterTaskId: firstAnchor.id,
      },
      mutation("equal-rank-move", actor),
    ).task;

    expect(taskboard.readBoard(ALL_PROJECT_ID, actor).tasks.map((task) => task.id)).toEqual([
      firstAnchor.id,
      source.id,
      secondAnchor.id,
    ]);
    expect(moved).toMatchObject({ projectId: projects.first.id, status: "todo", version: 3 });
    expect(taskboard.readTask(firstAnchor.id, actor)).toMatchObject({
      projectId: projects.second.id,
      status: "todo",
      version: firstAnchor.version,
    });
    expect(taskboard.readTask(secondAnchor.id, actor)).toMatchObject({
      projectId: projects.second.id,
      status: "todo",
      version: secondAnchor.version,
    });
    expect(database.prepare("SELECT * FROM tasks WHERE id = ?").get(hidden.id)).toEqual(
      hiddenBefore,
    );
  });

  it("appends without anchors at the end of the explicit all-project scope", () => {
    const { database, taskboard } = setup();
    const projects = syncCodexProjects(database);
    const a1 = taskboard.createTask(
      createCommand(projects.first.id, "全局首项", { status: "todo" }),
      mutation("global-tail-a1"),
    ).task;
    const a2 = taskboard.createTask(
      createCommand(projects.first.id, "全局次项", { status: "todo" }),
      mutation("global-tail-a2"),
    ).task;
    const b1 = taskboard.createTask(
      createCommand(projects.second.id, "移到全局末尾", { status: "todo" }),
      mutation("global-tail-b1"),
    ).task;

    taskboard.moveTask(
      b1.id,
      {
        expectedVersion: b1.version,
        targetStatus: "todo",
        boardProjectId: ALL_PROJECT_ID,
      },
      mutation("global-tail-move"),
    );

    expect(taskboard.readBoard(ALL_PROJECT_ID, ADMIN_ACTOR).tasks.map((task) => task.id)).toEqual([
      a1.id,
      a2.id,
      b1.id,
    ]);
  });

  it("rejects an unverified actor reordering across projects without changing any task record", () => {
    const { database, taskboard } = setup();
    const projects = syncCodexProjects(database);
    const editor = seedProjectMember(database, projects.first.id, {
      tenantKey: "tenant-private-sort",
      userId: "private-sort",
      name: "受限排序者",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    const actor: PrincipalView = {
      identity: editor.identity,
      name: editor.name,
      avatarUrl: null,
      role: "member",
    };
    const source = taskboard.createTask(
      createCommand(projects.first.id, "可写任务", { status: "todo" }),
      mutation("private-anchor-source"),
    ).task;
    const hiddenAnchor = taskboard.createTask(
      createCommand(projects.second.id, "不可读锚点", { status: "todo" }),
      mutation("private-anchor-target"),
    ).task;
    const before = database
      .prepare("SELECT id, project_id, status, sort_order, version FROM tasks ORDER BY id")
      .all();

    expect(() =>
      taskboard.moveTask(
        source.id,
        {
          expectedVersion: source.version,
          targetStatus: "todo",
          boardProjectId: ALL_PROJECT_ID,
          beforeTaskId: hiddenAnchor.id,
        },
        mutation("private-anchor-move", actor),
      ),
    ).toThrowError(AppError);
    expect(
      database
        .prepare("SELECT id, project_id, status, sort_order, version FROM tasks ORDER BY id")
        .all(),
    ).toEqual(before);
    expect(
      database
        .prepare("SELECT count(*) FROM request_idempotency WHERE idempotency_key = ?")
        .pluck()
        .get("private-anchor-move"),
    ).toBe(0);
  });

  it("rejects a foreign project scope and an anchor from another status before writing", () => {
    const { database, taskboard } = setup();
    const projects = syncCodexProjects(database);
    const source = taskboard.createTask(
      createCommand(projects.first.id, "排序范围源任务", { status: "todo" }),
      mutation("invalid-scope-source"),
    ).task;
    const wrongStatusAnchor = taskboard.createTask(
      createCommand(projects.first.id, "错误状态锚点", { status: "backlog" }),
      mutation("invalid-scope-anchor"),
    ).task;
    const before = database.prepare("SELECT * FROM tasks ORDER BY id").all();

    expect(() =>
      taskboard.moveTask(
        source.id,
        {
          expectedVersion: source.version,
          targetStatus: "todo",
          boardProjectId: projects.second.id,
        },
        mutation("invalid-foreign-scope"),
      ),
    ).toThrow(/排序看板与任务所属项目不匹配/);
    expect(() =>
      taskboard.moveTask(
        source.id,
        {
          expectedVersion: source.version,
          targetStatus: "todo",
          boardProjectId: projects.first.id,
          beforeTaskId: wrongStatusAnchor.id,
        },
        mutation("invalid-status-anchor"),
      ),
    ).toThrow(/排序锚点不在目标状态列中/);
    expect(database.prepare("SELECT * FROM tasks ORDER BY id").all()).toEqual(before);
  });

  it("preserves blocked origins, restores active states and rejects terminal-to-blocked moves", () => {
    const { project, taskboard } = setup();
    const created = taskboard.createTask(
      createCommand(project.id, "状态任务", { status: "todo" }),
      mutation("blocked-origin-create"),
    ).task;

    const blocked = taskboard.moveTask(
      created.id,
      { expectedVersion: created.version, targetStatus: "blocked" },
      mutation("blocked-origin-enter"),
    ).task;
    expect(blocked).toMatchObject({ status: "blocked", blockedFromStatus: "todo" });

    const stillBlocked = taskboard.moveTask(
      blocked.id,
      { expectedVersion: blocked.version, targetStatus: "blocked" },
      mutation("blocked-origin-remain"),
    ).task;
    expect(stillBlocked).toMatchObject({ status: "blocked", blockedFromStatus: "todo" });

    const restored = taskboard.moveTask(
      stillBlocked.id,
      { expectedVersion: stillBlocked.version, targetStatus: "in_review" },
      mutation("blocked-origin-restore"),
    ).task;
    expect(restored).toMatchObject({ status: "in_review", blockedFromStatus: null });

    const done = taskboard.moveTask(
      restored.id,
      { expectedVersion: restored.version, targetStatus: "done" },
      mutation("blocked-origin-done"),
    ).task;
    expect(done).toMatchObject({ status: "done", blockedFromStatus: null });

    expect(() =>
      taskboard.moveTask(
        done.id,
        { expectedVersion: done.version, targetStatus: "blocked" },
        mutation("blocked-origin-invalid-done"),
      ),
    ).toThrow(/恢复到活动状态/);

    const canceled = taskboard.createTask(
      createCommand(project.id, "取消任务", { status: "canceled" }),
      mutation("blocked-origin-canceled"),
    ).task;
    expect(() =>
      taskboard.moveTask(
        canceled.id,
        { expectedVersion: canceled.version, targetStatus: "blocked" },
        mutation("blocked-origin-invalid-canceled"),
      ),
    ).toThrow(/恢复到活动状态/);

    const directlyBlocked = taskboard.createTask(
      createCommand(project.id, "直接阻塞", { status: "blocked" }),
      mutation("blocked-origin-direct"),
    ).task;
    expect(directlyBlocked).toMatchObject({
      status: "blocked",
      blockedFromStatus: "in_progress",
    });
  });

  it("uses blocked tasks as sort anchors in their original active column", () => {
    const { project, taskboard } = setup();
    const first = taskboard.createTask(
      createCommand(project.id, "第一项", { status: "todo" }),
      mutation("blocked-anchor-first"),
    ).task;
    const blockedSource = taskboard.createTask(
      createCommand(project.id, "阻塞锚点", { status: "todo" }),
      mutation("blocked-anchor-source"),
    ).task;
    const blocked = taskboard.moveTask(
      blockedSource.id,
      { expectedVersion: blockedSource.version, targetStatus: "blocked" },
      mutation("blocked-anchor-block"),
    ).task;
    const movable = taskboard.createTask(
      createCommand(project.id, "待排序", { status: "in_progress" }),
      mutation("blocked-anchor-movable"),
    ).task;

    const moved = taskboard.moveTask(
      movable.id,
      {
        expectedVersion: movable.version,
        targetStatus: "todo",
        beforeTaskId: blocked.id,
        afterTaskId: first.id,
      },
      mutation("blocked-anchor-move"),
    ).task;

    expect(moved.sortOrder).toBeGreaterThan(first.sortOrder);
    expect(moved.sortOrder).toBeLessThan(blocked.sortOrder);
  });

  it("keeps at least three digits when task numbering crosses one thousand", () => {
    const { database, project, taskboard } = setup();
    database.prepare("UPDATE projects SET next_task_number = 999 WHERE id = ?").run(project.id);

    const task999 = taskboard.createTask(
      createCommand(project.id, "第九百九十九个任务"),
      mutation("create-task-0999"),
    );
    const task1000 = taskboard.createTask(
      createCommand(project.id, "第一千个任务"),
      mutation("create-task-1000"),
    );

    expect(task999.task.identifier).toBe("TASK-999");
    expect(task1000.task.identifier).toBe("TASK-1000");
  });

  it("returns the current resource on version conflict without partial writes", () => {
    const { database, project, taskboard } = setup();
    const created = taskboard.createTask(
      createCommand(project.id, "并发任务"),
      mutation("create-conflict-0001"),
    );
    const updated = taskboard.updateTask(
      created.task.id,
      { expectedVersion: created.task.version, priority: "urgent" },
      mutation("update-conflict-0002"),
    );

    let conflict: AppError | undefined;
    try {
      taskboard.updateTask(
        created.task.id,
        { expectedVersion: created.task.version, title: "过期客户端" },
        mutation("update-conflict-0003"),
      );
    } catch (error: unknown) {
      conflict = error as AppError;
    }
    expect(conflict).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { current: { version: updated.task.version, priority: "urgent" } },
    });
    expect(database.prepare("SELECT count(*) FROM activities").pluck().get()).toBe(2);
    expect(database.prepare("SELECT count(*) FROM change_events").pluck().get()).toBe(2);
    expect(database.prepare("SELECT count(*) FROM request_idempotency").pluck().get()).toBe(2);
  });

  it("rolls back entity, activity, revision, audit and idempotency when a transaction step fails", () => {
    const { database, project, taskboard, committedRevisions } = setup();
    const created = taskboard.createTask(
      createCommand(project.id, "事务任务"),
      mutation("create-rollback-0001"),
    );
    database.exec(`
      CREATE TRIGGER fail_task_updated_event
      BEFORE INSERT ON change_events
      WHEN NEW.event_type = 'task.updated'
      BEGIN
        SELECT RAISE(ABORT, 'forced change event failure');
      END;
    `);

    expect(() =>
      taskboard.updateTask(
        created.task.id,
        { expectedVersion: created.task.version, title: "不应保留" },
        mutation("update-rollback-0002"),
      ),
    ).toThrow(/forced change event failure/);

    expect(taskboard.readTask(created.task.id, ADMIN_ACTOR)).toMatchObject({
      title: "事务任务",
      version: 1,
    });
    expect(database.prepare("SELECT count(*) FROM activities").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM change_events").pluck().get()).toBe(1);
    expect(
      database
        .prepare("SELECT count(*) FROM audit_events WHERE action LIKE 'task.%'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(database.prepare("SELECT count(*) FROM request_idempotency").pluck().get()).toBe(1);
    expect(committedRevisions).toEqual([created.revision]);
  });

  it("allows verified legacy viewers to list projects and create tasks as themselves", () => {
    const { database, project, taskboard } = setup();
    const viewer = seedProjectMember(database, project.id, {
      tenantKey: "tenant-viewer",
      userId: "viewer",
      name: "只读成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const viewerActor: PrincipalView = {
      identity: viewer.identity,
      name: viewer.name,
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, viewerActor);

    database
      .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
      .run("/Users/test/TASK", project.id);
    new ProjectSyncService({ database }).reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "任务项目",
          rootPaths: ["/Users/test/TASK"],
          position: 0,
        },
      ],
    });

    expect(taskboard.listProjects(viewerActor)).toEqual([
      expect.objectContaining({ kind: "all" }),
      expect.objectContaining({ kind: "temporary" }),
      expect.objectContaining({ id: project.id, kind: "codex", membershipRole: null }),
    ]);
    const created = taskboard.createTask(
      createCommand(project.id, "登录用户的任务"),
      mutation("viewer-create-0001", viewerActor),
    ).task;
    expect(created).toMatchObject({
      projectId: project.id,
      assigneeIdentity: viewer.identity,
      permissions: { canRead: true, canWrite: true, canExecute: true },
    });
  });

  it("exposes the configured temporary display root and each task's primary Thread cwd", () => {
    const temporaryProjectRoot = "/fixture/temporary-project-root";
    const historicalTaskDirectory = "/fixture/temporary-project-root/2026-08-31";
    const { database, taskboard } = setup({ temporaryProjectRoot });
    const task = taskboard.createTask(
      createCommand(TEMPORARY_PROJECT_ID, "保留历史目录的临时任务"),
      mutation("temporary-directory-display"),
    ).task;

    expect(taskboard.listProjects(ADMIN_ACTOR)).toContainEqual(
      expect.objectContaining({
        id: TEMPORARY_PROJECT_ID,
        rootPaths: [temporaryProjectRoot],
      }),
    );
    expect(taskboard.readTask(task.id, ADMIN_ACTOR)).toMatchObject({
      workingDirectory: null,
    });

    database
      .prepare(
        `INSERT INTO task_threads (id, task_id, thread_id, cwd, is_primary)
        VALUES (?, ?, 'thread-historical-directory', ?, 1)`,
      )
      .run(crypto.randomUUID(), task.id, historicalTaskDirectory);

    expect(taskboard.readTask(task.id, ADMIN_ACTOR)).toMatchObject({
      workingDirectory: historicalTaskDirectory,
    });
  });
});

describe("task branch selection", () => {
  it.each([
    "queued",
    "running",
    "waiting_approval",
    "waiting_input",
    "canceling",
    "succeeded",
    "failed",
    "failed_recoverable",
    "canceled",
  ])("keeps branch locked after a %s execution", (status) => {
    const { database, project, taskboard } = setup();
    const contextId = "10000000-0000-4000-8000-000000000001";
    database
      .prepare(
        `INSERT INTO project_development_contexts (id,project_id,context_key,kind,label,branch,git_ref,head_sha,worktree_realpath,executable,active,scanned_at) VALUES (?,?,'branch:test','branch','test','test','refs/heads/test',?,NULL,0,1,?)`,
      )
      .run(contextId, project.id, "a".repeat(40), new Date().toISOString());
    const { task } = taskboard.createTask(
      createCommand(project.id, "Branch task"),
      mutation("branch-create"),
    );
    const changed = taskboard.updateTask(
      task.id,
      { expectedVersion: task.version, developmentContextId: contextId },
      mutation("branch-change"),
    ).task;
    expect(taskboard.readTask(task.id, ADMIN_ACTOR).developmentContextId).toBe(contextId);
    expect(changed.developmentContextLocked).toBe(false);
    database
      .prepare(
        "INSERT INTO jobs(id,task_id,kind,status,execution_key,idempotency_key,requested_by_identity_key) VALUES (?,?,'start',?,?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        task.id,
        status,
        "execution",
        "execution",
        identityKey(ADMIN_ACTOR.identity),
      );
    expect(taskboard.readTask(task.id, ADMIN_ACTOR).developmentContextLocked).toBe(true);
    expect(() =>
      taskboard.updateTask(
        task.id,
        { expectedVersion: changed.version, developmentContextId: null },
        mutation("branch-forbidden"),
      ),
    ).toThrow(/开始执行.*分支/);
    expect(taskboard.readTask(task.id, ADMIN_ACTOR).developmentContextId).toBe(contextId);
    expect(
      taskboard.updateTask(
        task.id,
        { expectedVersion: changed.version, title: "Updated title" },
        mutation("title-allowed"),
      ).task.title,
    ).toBe("Updated title");
  });
});

it("creates a task with multiple initial children and an already occupied parent", () => {
  const { project, taskboard, workspace } = setup();
  const parent = taskboard.createTask(
    createCommand(project.id, "父任务"),
    mutation("multi-parent"),
  ).task;
  const existing = taskboard.createTask(
    createCommand(project.id, "已有子任务"),
    mutation("multi-existing"),
  ).task;
  const children = ["A", "B"].map(
    (name) => taskboard.createTask(createCommand(project.id, name), mutation(`multi-${name}`)).task,
  );
  workspace.createRelation(
    parent.id,
    { relationType: "child", targetTaskId: existing.id },
    mutation("multi-original"),
  );
  const created = taskboard.createTask(
    createCommand(project.id, "第二个子任务兼父任务", {
      initialRelations: {
        parentTaskId: parent.id,
        childTaskId: null,
        childTaskIds: children.map((child) => child.id),
        relatedTaskIds: [],
      },
    }),
    mutation("multi-created"),
  ).task;
  const relations = workspace.readTaskWorkspace(created.id, ADMIN_ACTOR).relations;
  expect(
    relations
      .filter((r) => r.relationType === "child")
      .map((r) => r.targetTaskId)
      .sort(),
  ).toEqual(children.map((child) => child.id).sort());
  expect(relations.find((r) => r.relationType === "parent")?.targetTaskId).toBe(parent.id);
});
