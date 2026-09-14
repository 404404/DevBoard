import { seedProjectMember } from "./helpers/project-member-fixture.js";
import { identityKey, type IdentityRef } from "@lark-codex/contracts";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { ALL_PROJECT_ID, CreateTaskCommandSchema, type PrincipalView } from "@lark-codex/contracts";

import { appControl, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration, ProjectRegistry } from "../src/modules/project-registry/index.js";
import { Taskboard } from "../src/modules/taskboard/index.js";
import { FakeThreadProvisioner } from "./fake-thread-provisioner.js";

const openApps: FastifyInstance[] = [];
const openDatabases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

class CountingProjectRegistry extends ProjectRegistry {
  developmentContextReads = 0;
  developmentContextScans = 0;
  executionContextReads = 0;

  override readDevelopmentContexts(projectId: string) {
    this.developmentContextReads += 1;
    return super.readDevelopmentContexts(projectId);
  }

  override async scanDevelopmentContexts(projectId: string) {
    this.developmentContextScans += 1;
    return super.readDevelopmentContexts(projectId);
  }

  override async resolveExecutionContext(projectId: string, developmentContextId?: string) {
    this.executionContextReads += 1;
    return {
      projectId,
      developmentContextId: developmentContextId ?? null,
      cwd: process.cwd(),
      branch: "main",
      headSha: "a".repeat(40),
    };
  }
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cookieHeader(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function isolatedTestEnvironment(prefix: string) {
  const dataDirectory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dataDirectory);
  return {
    LARK_CODEX_ENV: "test",
    LARK_CODEX_AUTH_MODE: "feishu",
    LARK_CODEX_ORIGIN: "https://tasks.example.com",
    LARK_CODEX_ALLOWED_HOSTS: "tasks.example.com",
    LARK_CODEX_FEISHU_APP_ID: "cli_test",
    LARK_CODEX_FEISHU_APP_SECRET: "secret-for-test",
    LARK_CODEX_DATA_DIR: dataDirectory,
    LARK_CODEX_WORKSPACE_ROOTS: `${process.cwd()},${dataDirectory}`,
  } as const;
}

async function feishuSetup() {
  const config = loadConfig(isolatedTestEnvironment("lark-codex-http-development-"));
  const database = initializeDatabase(":memory:");
  seedFeishuTestActor(database);
  const provisioner = new FakeThreadProvisioner();
  const app = createApp({
    identityProvider: {
      kind: "feishu",
      async exchangeCode() {
        return TEST_FEISHU_ACTOR;
      },
    },
    config,
    database,
    codexThreadProvisioner: provisioner,
  });
  openApps.push(app);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "HTTP",
    name: "HTTP 项目",
    description: "",
  });
  database
    .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
    .run(process.cwd(), project.id);
  const trusted = { host: "tasks.example.com", origin: "https://tasks.example.com" };
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/feishu/exchange",
    payload: { code: "test-feishu-code" },
    headers: trusted,
  });
  return {
    app,
    database,
    project,
    trusted,
    cookies: cookieHeader(login),
    csrfToken: login.json().data.csrfToken as string,
    provisioner,
  };
}

describe("taskboard HTTP routes", () => {
  it("offers only the logged-in Feishu user as assignee while allowing project access without membership", async () => {
    const database = initializeDatabase(":memory:");
    seedFeishuTestActor(database);
    openDatabases.push(database);
    const administration = new ProjectAdministration(database);
    const project = administration.createProject({
      projectKey: "PICK",
      name: "创建选项项目",
      description: "",
    });
    const otherProject = administration.createProject({
      projectKey: "ELSE",
      name: "其他项目",
      description: "",
    });
    const viewer = seedProjectMember(database, project.id, {
      tenantKey: "tenant-options-viewer",
      userId: "options-viewer",
      name: "只读成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const editor = seedProjectMember(database, project.id, {
      tenantKey: "tenant-options-editor",
      userId: "options-editor",
      name: "编辑成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    const inactive = seedProjectMember(database, project.id, {
      tenantKey: "tenant-options-inactive",
      userId: "options-inactive",
      name: "失效成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
    database
      .prepare("UPDATE identities SET active = 0 WHERE identity_key = ?")
      .run(identityKey(inactive.identity));
    seedProjectMember(database, otherProject.id, {
      tenantKey: "tenant-options-outsider",
      userId: "options-outsider",
      name: "无权限成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });

    const seedIdentity = new IdentityService({
      database,
      provider: new DevelopmentIdentityAdapter(),
      sessionTtlSeconds: 300,
    });
    seedIdentity.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
    const seedActor: PrincipalView = {
      identity: TEST_FEISHU_ACTOR.identity,
      name: TEST_FEISHU_ACTOR.name,
      avatarUrl: null,
      role: "admin",
    };
    const seedTaskboard = new Taskboard({ database, identityService: seedIdentity });
    const insertLabel = database.prepare(
      `INSERT INTO global_labels (
        id, name, sort_order, created_by_identity_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ["Alpha", "Beta", "Hidden", "Other", "Zulu"].forEach((name, index) =>
      insertLabel.run(
        `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        name,
        index,
        identityKey(seedActor.identity),
        "2026-09-03T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
      ),
    );
    const createSeedTask = (
      projectId: string,
      title: string,
      labels: readonly string[],
      key: string,
    ) =>
      seedTaskboard.createTask(CreateTaskCommandSchema.parse({ projectId, title, labels }), {
        actor: seedActor,
        idempotencyKey: key,
      }).task;
    const first = createSeedTask(project.id, "候选任务一", ["Zulu", "Alpha"], "options-first");
    const second = createSeedTask(project.id, "候选任务二", ["Beta", "Alpha"], "options-second");
    const archived = createSeedTask(project.id, "已归档候选", ["Hidden"], "options-archived");
    seedTaskboard.archiveTask(
      archived.id,
      { expectedVersion: archived.version },
      { actor: seedActor, idempotencyKey: "options-archive" },
    );
    createSeedTask(otherProject.id, "其他项目任务", ["Other"], "options-other");

    const scannedAt = "2026-09-02T08:00:00.000Z";
    const insertContext = database.prepare(
      `INSERT INTO project_development_contexts (
        id, project_id, context_key, kind, label, branch, git_ref, head_sha,
        worktree_realpath, executable, active, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertContext.run(
      "10000000-0000-4000-8000-000000000001",
      project.id,
      "worktree:main",
      "worktree",
      "main",
      "main",
      "refs/heads/main",
      "a".repeat(40),
      process.cwd(),
      1,
      1,
      scannedAt,
    );
    insertContext.run(
      "10000000-0000-4000-8000-000000000003",
      project.id,
      "branch:refs/heads/feature/options",
      "branch",
      "feature/options",
      "feature/options",
      "refs/heads/feature/options",
      "c".repeat(40),
      process.cwd(),
      1,
      1,
      scannedAt,
    );
    insertContext.run(
      "10000000-0000-4000-8000-000000000002",
      project.id,
      "branch:refs/heads/stale",
      "branch",
      "stale",
      "stale",
      "refs/heads/stale",
      "b".repeat(40),
      null,
      0,
      0,
      scannedAt,
    );

    const config = loadConfig({
      ...isolatedTestEnvironment("lark-codex-http-options-"),
      LARK_CODEX_AUTH_MODE: "feishu",
      LARK_CODEX_ORIGIN: "https://tasks.example.com",
      LARK_CODEX_ALLOWED_HOSTS: "tasks.example.com",
      LARK_CODEX_FEISHU_APP_ID: "cli_test",
      LARK_CODEX_FEISHU_APP_SECRET: "secret-for-test",
    });
    const projectRegistry = new CountingProjectRegistry(
      database,
      config.LARK_CODEX_WORKSPACE_ROOTS,
    );
    const app = createApp({
      config,
      database,
      projectRegistry,
      codexThreadProvisioner: new FakeThreadProvisioner(),
      identityProvider: {
        kind: "feishu",
        async exchangeCode(code) {
          return code === "viewer-authorization-code"
            ? {
                identity: {
                  kind: "feishu",
                  tenantKey: "tenant-options-viewer",
                  userId: "options-viewer",
                },
                name: "只读成员",
                avatarUrl: null,
              }
            : {
                identity: {
                  kind: "feishu",
                  tenantKey: "tenant-options-outsider",
                  userId: "options-outsider",
                },
                name: "无权限成员",
                avatarUrl: null,
              };
        },
      },
      closeDatabaseOnClose: false,
    });
    openApps.push(app);
    const trusted = { host: "tasks.example.com", origin: "https://tasks.example.com" };
    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: trusted,
      payload: { code: "viewer-authorization-code" },
    });
    const options = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/task-creation-options`,
      headers: { host: trusted.host, cookie: cookieHeader(viewerLogin) },
    });

    expect(options.statusCode, JSON.stringify(options.json())).toBe(200);
    expect(options.json().data).toMatchObject({
      projectId: project.id,
      currentIdentity: viewer.identity,
      labels: [
        expect.objectContaining({ name: "Alpha", sortOrder: 0 }),
        expect.objectContaining({ name: "Beta", sortOrder: 1 }),
        expect.objectContaining({ name: "Hidden", sortOrder: 2 }),
        expect.objectContaining({ name: "Other", sortOrder: 3 }),
        expect.objectContaining({ name: "Zulu", sortOrder: 4 }),
      ],
      developmentContexts: [
        {
          id: "10000000-0000-4000-8000-000000000003",
          label: "feature/options",
          active: true,
        },
      ],
      defaultDevelopmentContext: { id: null, label: "main", branch: "main" },
      attachmentMaxBytes: config.LARK_CODEX_ATTACHMENT_MAX_BYTES,
      relationCandidates: [
        { id: first.id, identifier: "PICK-001", title: "候选任务一" },
        { id: second.id, identifier: "PICK-002", title: "候选任务二" },
      ],
    });
    expect(options.json().data.assignees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: viewer.identity,
          avatarUrl: null,
          projectRole: null,
        }),
      ]),
    );
    expect(options.json().data.assignees).toHaveLength(1);
    expect(
      options
        .json()
        .data.assignees.map((actor: { identity: IdentityRef }) => identityKey(actor.identity)),
    ).not.toContain(identityKey(editor.identity));
    expect(JSON.stringify(options.json())).not.toContain(DEVELOPMENT_IDENTITY.name);
    expect(JSON.stringify(options.json())).not.toContain("失效成员");
    expect(projectRegistry.developmentContextReads).toBe(0);
    expect(projectRegistry.developmentContextScans).toBe(1);
    expect(projectRegistry.executionContextReads).toBe(1);

    projectRegistry.developmentContextReads = 0;
    projectRegistry.developmentContextScans = 0;
    const allProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${ALL_PROJECT_ID}/task-creation-options`,
      headers: { host: trusted.host, cookie: cookieHeader(viewerLogin) },
    });
    expect(allProject.statusCode).toBe(409);
    expect(projectRegistry.developmentContextReads).toBe(0);
    expect(projectRegistry.developmentContextScans).toBe(0);
    expect(projectRegistry.executionContextReads).toBe(1);

    const outsiderLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: trusted,
      payload: { code: "outsider-authorization-code" },
    });
    projectRegistry.developmentContextReads = 0;
    projectRegistry.developmentContextScans = 0;
    const otherUserOptions = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/task-creation-options`,
      headers: { host: trusted.host, cookie: cookieHeader(outsiderLogin) },
    });
    expect(otherUserOptions.statusCode).toBe(200);
    expect(otherUserOptions.json().data.currentIdentity).toEqual(
      outsiderLogin.json().data.actor.identity,
    );
    expect(
      otherUserOptions
        .json()
        .data.assignees.map((actor: { identity: IdentityRef }) => actor.identity),
    ).toEqual([outsiderLogin.json().data.actor.identity]);
    expect(projectRegistry.developmentContextReads).toBe(0);
    expect(projectRegistry.developmentContextScans).toBe(1);
  });

  it("creates a temporary task with one draft Thread in Codex Recent", async () => {
    const { app, trusted, cookies, csrfToken, provisioner } = await feishuSetup();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "http-create-temporary-draft",
      },
      payload: {
        projectId: "00000000-0000-4000-8000-0000000000a2",
        title: "最近待执行任务",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      projectName: "临时项目",
      codexThreadState: "draft",
    });
    expect(provisioner.created).toEqual([{ cwd: null, name: "TEMP-001 最近待执行任务" }]);
  });

  it("archives the linked Codex task before permanently deleting a canceled task", async () => {
    const { app, database, project, trusted, cookies, csrfToken, provisioner } =
      await feishuSetup();
    const headers = (idempotencyKey: string) => ({
      ...trusted,
      cookie: cookies,
      "x-csrf-token": csrfToken,
      "idempotency-key": idempotencyKey,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: headers("http-delete-create"),
      payload: { projectId: project.id, title: "待删除任务" },
    });
    const task = created.json().data;
    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/move`,
      headers: headers("http-delete-cancel"),
      payload: { expectedVersion: task.version, targetStatus: "canceled" },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${task.id}`,
      headers: headers("http-delete-confirm"),
      payload: { expectedVersion: canceled.json().data.version },
    });

    expect(deleted.statusCode, JSON.stringify(deleted.json())).toBe(200);
    expect(deleted.json().data).toMatchObject({ taskId: task.id, projectId: project.id });
    expect(provisioner.archived).toEqual(["thread-draft-1"]);
    expect(database.prepare("SELECT count(*) FROM tasks WHERE id = ?").pluck().get(task.id)).toBe(
      0,
    );
  });

  it("exposes read-only system/Codex boards and reassigns temporary history", async () => {
    const environment = isolatedTestEnvironment("lark-codex-http-project-sync-");
    const config = loadConfig(environment);
    const database = initializeDatabase(":memory:");
    seedFeishuTestActor(database);
    const app = createApp({
      identityProvider: {
        kind: "feishu",
        async exchangeCode() {
          return TEST_FEISHU_ACTOR;
        },
      },
      config,
      database,
      codexThreadProvisioner: new FakeThreadProvisioner(),
    });
    openApps.push(app);
    const trusted = { host: "tasks.example.com", origin: "https://tasks.example.com" };
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      payload: { code: "test-feishu-code" },
      headers: trusted,
    });
    const cookies = cookieHeader(login);
    const csrfToken = login.json().data.csrfToken as string;
    const projectSync = appControl(app).services.projectSync;
    const paperDirectory = join(environment.LARK_CODEX_DATA_DIR, "paper");
    mkdirSync(paperDirectory);
    const paperRoot = realpathSync(paperDirectory);
    const dockerRoot = realpathSync(environment.LARK_CODEX_DATA_DIR);
    projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "论文",
          rootPaths: [paperRoot],
          position: 0,
        },
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "Docker",
          rootPaths: [dockerRoot],
          position: 1,
        },
      ],
    });

    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { ...trusted, cookie: cookies },
    });
    expect(projects.statusCode).toBe(200);
    expect(
      projects
        .json()
        .data.map((project: { kind: string; name: string }) => [project.kind, project.name]),
    ).toEqual([
      ["all", "全部项目"],
      ["temporary", "临时项目"],
      ["codex", "论文"],
      ["codex", "Docker"],
    ]);
    const [, temporary, paper, docker] = projects.json().data;
    expect(paper).toMatchObject({
      rootPaths: [paperRoot],
      syncState: "synced",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "sync-http-task-create",
      },
      payload: { projectId: paper.id, title: "保留的论文任务", status: "todo" },
    });
    expect(created.statusCode).toBe(201);
    projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:01:00.000Z",
      projects: [
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "Docker",
          rootPaths: [dockerRoot],
          position: 0,
        },
      ],
    });

    const temporaryBoard = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${temporary.id}/board`,
      headers: { ...trusted, cookie: cookies },
    });
    expect(temporaryBoard.statusCode).toBe(200);
    expect(temporaryBoard.json().data.tasks[0]).toMatchObject({
      projectName: "临时项目",
      originProjectName: "论文",
      permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: true },
    });
    const allBoard = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-4000-8000-0000000000a1/board",
      headers: { ...trusted, cookie: cookies },
    });
    expect(allBoard.json().data.tasks).toHaveLength(1);

    const task = temporaryBoard.json().data.tasks[0];
    const reassigned = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/reassign`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "sync-http-task-reassign",
      },
      payload: { expectedVersion: task.version, targetProjectId: docker.id, mode: "single" },
    });
    expect(reassigned.statusCode, JSON.stringify(reassigned.json())).toBe(200);
    expect(reassigned.json().data).toMatchObject({
      projectId: docker.id,
      projectName: "Docker",
      originProjectName: null,
    });
  });

  it("enforces authentication, CSRF and idempotency then exposes safe project/task views", async () => {
    const { app, project, trusted, cookies, csrfToken } = await feishuSetup();

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { host: trusted.host },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().data.map((entry: { kind: string }) => entry.kind)).toEqual([
      "all",
      "temporary",
    ]);
    expect(projects.json().data[0]).not.toHaveProperty("workspaceRealpath");

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...trusted, cookie: cookies, "idempotency-key": "http-create-0001" },
      payload: { projectId: project.id, title: "HTTP 任务" },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().error.code).toBe("CSRF_INVALID");

    const missingIdempotency = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...trusted, cookie: cookies, "x-csrf-token": csrfToken },
      payload: { projectId: project.id, title: "HTTP 任务" },
    });
    expect(missingIdempotency.statusCode).toBe(400);

    const writeHeaders = {
      ...trusted,
      cookie: cookies,
      "x-csrf-token": csrfToken,
      "idempotency-key": "http-create-0001",
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: writeHeaders,
      payload: { projectId: project.id, title: "HTTP 任务", status: "todo" },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: writeHeaders,
      payload: { projectId: project.id, title: "HTTP 任务", status: "todo" },
    });
    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());

    const task = created.json().data;
    const details = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${task.id}`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().data).toMatchObject({ identifier: "HTTP-001", version: 1 });

    const board = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/board`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(board.statusCode).toBe(200);
    expect(board.json().data.tasks).toHaveLength(1);
  });

  it("returns a recoverable current-resource summary for stale HTTP updates", async () => {
    const { app, project, trusted, cookies, csrfToken } = await feishuSetup();
    const baseHeaders = {
      ...trusted,
      cookie: cookies,
      "x-csrf-token": csrfToken,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...baseHeaders, "idempotency-key": "http-conflict-create" },
      payload: { projectId: project.id, title: "冲突任务" },
    });
    const task = created.json().data;
    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${task.id}`,
      headers: { ...baseHeaders, "idempotency-key": "http-conflict-first" },
      payload: { expectedVersion: task.version, priority: "urgent" },
    });
    expect(first.statusCode).toBe(200);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${task.id}`,
      headers: { ...baseHeaders, "idempotency-key": "http-conflict-stale" },
      payload: { expectedVersion: task.version, title: "过期更新" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { current: { version: 2, priority: "urgent" } },
    });
  });

  it("allows a verified legacy viewer to read and create tasks while enforcing attachment limits", async () => {
    const database = initializeDatabase(":memory:");
    seedFeishuTestActor(database);
    openDatabases.push(database);
    const administration = new ProjectAdministration(database);
    const project = administration.createProject({
      projectKey: "VIEW",
      name: "只读项目",
      description: "",
    });
    seedProjectMember(database, project.id, {
      tenantKey: "tenant-viewer",
      userId: "viewer-open-id",
      name: "只读成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const seedIdentity = new IdentityService({
      database,
      provider: new DevelopmentIdentityAdapter(),
      sessionTtlSeconds: 300,
    });
    seedIdentity.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
    const protectedTask = new Taskboard({ database, identityService: seedIdentity }).createTask(
      {
        projectId: project.id,
        title: "只读附件任务",
        description: "",
        status: "todo",
        priority: "none",
        labels: [],
        assigneeIdentity: null,
        startAt: null,
        dueAt: null,
        recurrence: null,
        developmentContextId: null,
        links: [],
        initialRelations: {
          parentTaskId: null,
          childTaskId: null,
          relatedTaskIds: [],
        },
      },
      {
        actor: {
          identity: TEST_FEISHU_ACTOR.identity,
          name: TEST_FEISHU_ACTOR.name,
          avatarUrl: null,
          role: "admin",
        },
        idempotencyKey: "viewer-seed-task-0001",
      },
    ).task;
    const config = loadConfig({
      ...isolatedTestEnvironment("lark-codex-http-feishu-"),
      LARK_CODEX_AUTH_MODE: "feishu",
      LARK_CODEX_ORIGIN: "https://tasks.example.com",
      LARK_CODEX_ALLOWED_HOSTS: "tasks.example.com",
      LARK_CODEX_FEISHU_APP_ID: "cli_test",
      LARK_CODEX_FEISHU_APP_SECRET: "secret-for-test",
      LARK_CODEX_ATTACHMENT_MAX_BYTES: "1024",
    });
    const app = createApp({
      config,
      database,
      codexThreadProvisioner: new FakeThreadProvisioner(),
      identityProvider: {
        kind: "feishu",
        async exchangeCode() {
          return {
            identity: { kind: "feishu", tenantKey: "tenant-viewer", userId: "viewer-open-id" },
            name: "只读成员",
            avatarUrl: null,
          };
        },
      },
      closeDatabaseOnClose: false,
    });
    openApps.push(app);
    const trusted = { host: "tasks.example.com", origin: "https://tasks.example.com" };
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: trusted,
      payload: { code: "viewer-authorization-code" },
    });
    const cookies = cookieHeader(login);
    const csrfToken = login.json().data.csrfToken as string;

    const board = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/board`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(board.statusCode).toBe(200);

    const oversize = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${protectedTask.id}/attachments`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "viewer-oversize-attachment-0001",
        "content-type": "application/octet-stream",
        "x-content-type": "text/plain",
        "x-filename": "oversize.txt",
      },
      payload: Buffer.alloc(1_025, "x"),
    });
    expect(oversize.statusCode).toBe(413);
    expect(oversize.json().error.code).toBe("INVALID_REQUEST");

    database
      .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
      .run(process.cwd(), project.id);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "viewer-write-0001",
      },
      payload: { projectId: project.id, title: "登录用户任务" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data).toMatchObject({
      title: "登录用户任务",
      assigneeIdentity: login.json().data.actor.identity,
      permissions: { canRead: true, canWrite: true, canExecute: true },
    });
  });

  it("exposes versioned comments, relations, workspace, dashboard and read state", async () => {
    const { app, database, project, trusted, cookies, csrfToken } = await feishuSetup();
    const write = (key: string) => ({
      ...trusted,
      cookie: cookies,
      "x-csrf-token": csrfToken,
      "idempotency-key": key,
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: write("workspace-http-task-0001"),
      payload: { projectId: project.id, title: "主任务", status: "blocked" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: write("workspace-http-task-0002"),
      payload: { projectId: project.id, title: "关联任务" },
    });
    const task = first.json().data;
    const target = second.json().data;

    const comment = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: write("workspace-http-comment-0003"),
      payload: { body: "**HTTP 评论**" },
    });
    expect(comment.statusCode).toBe(201);

    const relation = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/relations`,
      headers: write("workspace-http-relation-0004"),
      payload: { relationType: "blocks", targetTaskId: target.id },
    });
    expect(relation.statusCode).toBe(201);

    const workspace = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${task.id}/workspace`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json().data).toMatchObject({
      task: { id: task.id },
      comments: [{ body: "**HTTP 评论**" }],
      relations: [{ relationType: "blocks", targetTaskId: target.id }],
      executionSummary: { total: 0, active: 0, latest: null },
    });

    const dashboardBefore = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/dashboard`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(dashboardBefore.statusCode).toBe(200);
    expect(dashboardBefore.json().data).toMatchObject({
      totalTasks: 2,
      blockedOrUnreadCount: 2,
    });

    const read = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${target.id}/read`,
      headers: write("workspace-http-read-0005"),
      payload: {},
    });
    expect(read.statusCode).toBe(204);
    expect(read.headers["x-event-revision"]).toMatch(/^\d+$/);
    expect(
      database
        .prepare("SELECT count(*) FROM change_events WHERE event_type = 'task.read'")
        .pluck()
        .get(),
    ).toBe(1);
    const dashboardAfter = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/dashboard`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(dashboardAfter.json().data.blockedOrUnreadCount).toBe(1);
  });

  it("accepts only one of two concurrent edits based on the same comment version", async () => {
    const { app, project, trusted, cookies, csrfToken } = await feishuSetup();
    const write = (key: string) => ({
      ...trusted,
      cookie: cookies,
      "x-csrf-token": csrfToken,
      "idempotency-key": key,
    });
    const createdTask = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: write("concurrent-comment-task"),
      payload: { projectId: project.id, title: "并发评论任务" },
    });
    const task = createdTask.json().data;
    const createdComment = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: write("concurrent-comment-create"),
      payload: { body: "共同基线" },
    });
    const comment = createdComment.json().data;
    const edits = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/v1/comments/${comment.id}`,
        headers: write("concurrent-comment-edit-a"),
        payload: { expectedVersion: comment.version, body: "客户端 A" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/v1/comments/${comment.id}`,
        headers: write("concurrent-comment-edit-b"),
        payload: { expectedVersion: comment.version, body: "客户端 B" },
      }),
    ]);
    expect(edits.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(edits.find((response) => response.statusCode === 409)?.json().error.code).toBe(
      "VERSION_CONFLICT",
    );
  });

  it("uploads and downloads attachments without exposing storage paths", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "lark-codex-http-attachment-"));
    temporaryDirectories.push(dataDirectory);
    const config = loadConfig({
      LARK_CODEX_ENV: "test",
      LARK_CODEX_AUTH_MODE: "feishu",
      LARK_CODEX_ORIGIN: "https://tasks.example.com",
      LARK_CODEX_ALLOWED_HOSTS: "tasks.example.com",
      LARK_CODEX_FEISHU_APP_ID: "cli_test",
      LARK_CODEX_FEISHU_APP_SECRET: "secret-for-test",
      LARK_CODEX_DATA_DIR: dataDirectory,
      LARK_CODEX_WORKSPACE_ROOTS: process.cwd(),
      LARK_CODEX_ATTACHMENT_MAX_BYTES: "1024",
    });
    const database = initializeDatabase(":memory:");
    seedFeishuTestActor(database);
    const app = createApp({
      identityProvider: {
        kind: "feishu",
        async exchangeCode() {
          return TEST_FEISHU_ACTOR;
        },
      },
      config,
      database,
      codexThreadProvisioner: new FakeThreadProvisioner(),
    });
    openApps.push(app);
    const project = new ProjectAdministration(database).createProject({
      projectKey: "FILES",
      name: "附件项目",
      description: "",
    });
    database
      .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
      .run(process.cwd(), project.id);
    const trusted = { host: "tasks.example.com", origin: "https://tasks.example.com" };
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      payload: { code: "test-feishu-code" },
      headers: trusted,
    });
    const cookies = cookieHeader(login);
    const csrfToken = login.json().data.csrfToken as string;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-task-0001",
      },
      payload: { projectId: project.id, title: "附件任务" },
    });
    const task = created.json().data;
    const bytes = Buffer.from("%PDF-1.7\nworkspace evidence");
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/attachments`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-upload-0002",
        "content-type": "application/octet-stream",
        "x-content-type": "application/pdf",
        "x-filename": encodeURIComponent("验收证据.pdf"),
      },
      payload: bytes,
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().data).toMatchObject({
      taskId: task.id,
      filename: "验收证据.pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.length,
    });
    expect(JSON.stringify(uploaded.json())).not.toContain("storageKey");
    expect(JSON.stringify(uploaded.json())).not.toContain(dataDirectory);

    const filesBeforeConflict = readdirSync(join(dataDirectory, "attachments"), {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile()).length;
    const idempotencyConflict = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/attachments`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-upload-0002",
        "content-type": "application/octet-stream",
        "x-content-type": "application/pdf",
        "x-filename": encodeURIComponent("另一份证据.pdf"),
      },
      payload: Buffer.from("%PDF-1.7\nconflicting bytes"),
    });
    expect(idempotencyConflict.statusCode).toBe(409);
    expect(
      readdirSync(join(dataDirectory, "attachments"), {
        recursive: true,
        withFileTypes: true,
      }).filter((entry) => entry.isFile()).length,
    ).toBe(filesBeforeConflict);

    const attachment = uploaded.json().data;
    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment.id}`,
      headers: { host: trusted.host },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const unauthenticatedOversize = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/attachments`,
      headers: {
        ...trusted,
        "content-type": "application/octet-stream",
        "x-content-type": "text/plain",
        "x-filename": "oversize.txt",
      },
      payload: Buffer.alloc(1_025, "x"),
    });
    expect(unauthenticatedOversize.statusCode).toBe(401);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment.id}`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(bytes);
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
    expect(downloaded.headers["content-disposition"]).toContain("attachment;");

    const previewed = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment.id}?preview=1`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.rawPayload).toEqual(bytes);
    expect(previewed.headers["content-disposition"]).toContain("inline;");

    const missingCsrfDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachment.id}`,
      headers: {
        ...trusted,
        cookie: cookies,
        "idempotency-key": "attachment-delete-0006",
      },
    });
    expect(missingCsrfDelete.statusCode).toBe(403);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachment.id}`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-delete-0006",
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toMatchObject({
      id: attachment.id,
      taskId: task.id,
      filename: "验收证据.pdf",
    });
    const replayedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachment.id}`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-delete-0006",
      },
    });
    expect(replayedDelete.statusCode).toBe(200);
    expect(replayedDelete.json()).toEqual(deleted.json());
    const missingAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment.id}`,
      headers: { host: trusted.host, cookie: cookies },
    });
    expect(missingAfterDelete.statusCode).toBe(404);
    expect(
      database.prepare("SELECT count(*) FROM attachments WHERE id = ?").pluck().get(attachment.id),
    ).toBe(0);
    expect(
      database
        .prepare(
          "SELECT count(*) FROM activities WHERE task_id = ? AND kind = 'attachment.deleted'",
        )
        .pluck()
        .get(task.id),
    ).toBe(1);
    const deletedEvent = database
      .prepare(
        "SELECT safe_payload_json FROM change_events WHERE aggregate_id = ? AND event_type = 'attachment.deleted'",
      )
      .pluck()
      .get(attachment.id) as string;
    expect(JSON.parse(deletedEvent)).toMatchObject({
      projectId: project.id,
      taskId: task.id,
      attachmentId: attachment.id,
      filename: "验收证据.pdf",
    });

    const traversal = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/attachments`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-upload-0003",
        "content-type": "application/octet-stream",
        "x-content-type": "text/plain",
        "x-filename": encodeURIComponent("../secret.txt"),
      },
      payload: Buffer.from("secret"),
    });
    expect(traversal.statusCode).toBe(400);

    for (const [filename, declaredType, payload] of [
      ["evidence.json", "application/json", Buffer.from('{"result":"passed"}')],
      ["evidence.csv", "text/csv", Buffer.from("name,result\nworkspace,passed\n")],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.id}/attachments`,
        headers: {
          ...trusted,
          cookie: cookies,
          "x-csrf-token": csrfToken,
          "idempotency-key": `attachment-${filename}`,
          "content-type": "application/octet-stream",
          "x-content-type": declaredType,
          "x-filename": encodeURIComponent(filename),
        },
        payload,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data).toMatchObject({ filename, contentType: declaredType });
    }

    const oversize = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/attachments`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-oversize-0004",
        "content-type": "application/octet-stream",
        "x-content-type": "text/plain",
        "x-filename": "oversize.txt",
      },
      payload: Buffer.alloc(1_025, "x"),
    });
    expect(oversize.statusCode).toBe(413);

    const malformedFilename = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/attachments`,
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": "attachment-malformed-0005",
        "content-type": "application/octet-stream",
        "x-content-type": "text/plain",
        "x-filename": "%E0%A4%A",
      },
      payload: Buffer.from("invalid name"),
    });
    expect(malformedFilename.statusCode).toBe(400);
  });
});

it("rejects requested assignee impersonation instead of silently replacing it at the HTTP boundary", async () => {
  const { app, database, project, trusted, cookies, csrfToken, provisioner } = await feishuSetup();
  const other = seedFeishuTestActor(database, {
    ...TEST_FEISHU_ACTOR,
    identity: { kind: "feishu", tenantKey: "other-tenant", userId: "test-admin" },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: {
      ...trusted,
      cookie: cookies,
      "x-csrf-token": csrfToken,
      "idempotency-key": "reject-http-assignee",
    },
    payload: { projectId: project.id, title: "Spoofed assignee", assigneeIdentity: other.identity },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().error.code).toBe("FORBIDDEN");
  expect(provisioner.created).toHaveLength(0);
  expect(database.prepare("SELECT count(*) FROM tasks").pluck().get()).toBe(0);
});
