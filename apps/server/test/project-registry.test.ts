import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ALL_PROJECT_ID, TEMPORARY_PROJECT_ID } from "@lark-taskboard/contracts";

import { AppError } from "../src/app-error.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { ProjectAdministration, ProjectRegistry } from "../src/modules/project-registry/index.js";
import { ProjectSyncService } from "../src/modules/project-sync/index.js";

const temporaryDirectories: string[] = [];
const openDatabases: SqliteDatabase[] = [];

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

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", cwd, ...arguments_], { encoding: "utf8" });
}

function createGitRepository(parent: string): string {
  const repository = join(parent, "repository");
  mkdirSync(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Taskboard Test");
  git(repository, "config", "user.email", "taskboard@example.test");
  writeFileSync(join(repository, "README.md"), "# Test repository\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  return repository;
}

function setup() {
  const allowedRoot = temporaryDirectory("lark-taskboard-registry-");
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const administration = new ProjectAdministration(database);
  const registry = new ProjectRegistry(database, [allowedRoot]);
  return { allowedRoot, database, administration, registry };
}

describe("Project Registry module", () => {
  it("returns only active executable development contexts backed by worktrees", () => {
    const { administration, database, registry } = setup();
    const project = administration.createProject({
      projectKey: "READ",
      name: "只读上下文项目",
      description: "",
    });
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
      "branch:refs/heads/main",
      "branch",
      "main",
      "main",
      "refs/heads/main",
      "a".repeat(40),
      null,
      0,
      1,
      scannedAt,
    );
    insertContext.run(
      "10000000-0000-4000-8000-000000000002",
      project.id,
      "worktree:feature-ready",
      "worktree",
      "feature/ready · feature-ready",
      "feature/ready",
      "refs/heads/feature/ready",
      "b".repeat(40),
      process.cwd(),
      1,
      1,
      scannedAt,
    );
    insertContext.run(
      "10000000-0000-4000-8000-000000000003",
      project.id,
      "branch:refs/heads/stale",
      "branch",
      "stale",
      "stale",
      "refs/heads/stale",
      "c".repeat(40),
      process.cwd(),
      1,
      0,
      scannedAt,
    );

    expect(registry.readDevelopmentContexts(project.id)).toEqual([
      {
        id: "10000000-0000-4000-8000-000000000002",
        kind: "worktree",
        label: "feature/ready · feature-ready",
        branch: "feature/ready",
        gitRef: "refs/heads/feature/ready",
        headSha: "b".repeat(40),
        worktreeRealpath: process.cwd(),
        executable: true,
        active: true,
        scannedAt,
      },
    ]);
  });

  it("reads system projects with their nullable keys and rejects system execution cleanly", async () => {
    const { administration, registry } = setup();

    expect(administration.listProjects()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ALL_PROJECT_ID, kind: "system", projectKey: null }),
        expect.objectContaining({
          id: TEMPORARY_PROJECT_ID,
          kind: "system",
          projectKey: "TEMP",
        }),
      ]),
    );
    await expect(registry.resolveExecutionContext(ALL_PROJECT_ID)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      statusCode: 409,
    });
  });

  it("uses the first trusted Codex root even when it is not a Git repository", async () => {
    const { allowedRoot, database, registry } = setup();
    const plainDirectory = join(allowedRoot, "codex-plain-folder");
    mkdirSync(plainDirectory);
    new ProjectSyncService({ database }).reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "普通文件夹项目",
          rootPaths: [realpathSync(plainDirectory)],
          position: 0,
        },
      ],
    });
    const projectId = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .pluck()
      .get("11111111-1111-4111-8111-111111111111") as string;

    await expect(registry.resolveExecutionContext(projectId)).resolves.toEqual({
      projectId,
      developmentContextId: null,
      cwd: realpathSync(plainDirectory),
      branch: null,
      headSha: null,
    });
  });

  it("registers one executable context per checked-out branch and deactivates deleted worktrees", async () => {
    const { allowedRoot, administration, registry } = setup();
    const repository = createGitRepository(allowedRoot);
    git(repository, "branch", "feature/context");
    const worktree = join(allowedRoot, "feature-worktree");
    git(repository, "worktree", "add", worktree, "feature/context");
    const project = administration.createProject({
      projectKey: "LOCAL",
      name: "本地项目",
      description: "",
    });

    const registration = await registry.registerWorkspace(project.id, {
      absolutePath: repository,
      expectedVersion: project.version,
    });

    expect(registration.project).toMatchObject({
      workspaceRealpath: realpathSync(repository),
      version: 2,
    });
    expect(registration.repository).toMatchObject({ branch: "main", dirty: false });
    expect(registration.contexts.filter((context) => context.active)).toEqual([
      expect.objectContaining({
        kind: "branch",
        label: "feature/context",
        branch: "feature/context",
        worktreeRealpath: realpathSync(worktree),
        executable: true,
      }),
      expect.objectContaining({
        kind: "branch",
        label: "main",
        branch: "main",
        worktreeRealpath: realpathSync(repository),
        executable: true,
      }),
    ]);
    expect(
      registration.contexts.filter((context) => context.branch === "feature/context"),
    ).toHaveLength(1);

    const featureBranch = registration.contexts.find(
      (context) => context.kind === "branch" && context.branch === "feature/context",
    );
    expect(featureBranch).toBeDefined();
    const rescanned = await registry.scanDevelopmentContexts(project.id);
    expect(
      rescanned.find((context) => context.kind === "branch" && context.branch === "feature/context")
        ?.id,
    ).toBe(featureBranch?.id);
    await expect(
      registry.resolveExecutionContext(project.id, featureBranch?.id),
    ).resolves.toMatchObject({
      cwd: realpathSync(worktree),
      branch: "feature/context",
    });

    git(repository, "worktree", "remove", worktree);
    const afterWorktreeRemoval = await registry.scanDevelopmentContexts(project.id);
    expect(
      afterWorktreeRemoval.find(
        (context) => context.kind === "branch" && context.branch === "feature/context",
      ),
    ).toMatchObject({ active: true, executable: false, worktreeRealpath: null });
    expect(registry.readDevelopmentContexts(project.id).map((context) => context.branch)).toEqual([
      "main",
    ]);

    git(repository, "branch", "-D", "feature/context");
    const afterBranchRemoval = await registry.scanDevelopmentContexts(project.id);
    expect(
      afterBranchRemoval.find(
        (context) => context.kind === "branch" && context.branch === "feature/context",
      ),
    ).toMatchObject({ active: false, executable: false });
  });

  it("rejects subdirectories, non-Git directories, duplicate binding and symlink escape", async () => {
    const { allowedRoot, administration, registry } = setup();
    const repository = createGitRepository(allowedRoot);
    const subdirectory = join(repository, "src");
    mkdirSync(subdirectory);
    const first = administration.createProject({
      projectKey: "FIRST",
      name: "第一个项目",
      description: "",
    });

    await expect(
      registry.registerWorkspace(first.id, {
        absolutePath: subdirectory,
        expectedVersion: first.version,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const plainDirectory = join(allowedRoot, "plain");
    mkdirSync(plainDirectory);
    await expect(
      registry.registerWorkspace(first.id, {
        absolutePath: plainDirectory,
        expectedVersion: first.version,
      }),
    ).rejects.toBeInstanceOf(AppError);

    await registry.registerWorkspace(first.id, {
      absolutePath: repository,
      expectedVersion: first.version,
    });
    const second = administration.createProject({
      projectKey: "SECOND",
      name: "第二个项目",
      description: "",
    });
    await expect(
      registry.registerWorkspace(second.id, {
        absolutePath: repository,
        expectedVersion: second.version,
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_REQUEST" });

    const outsideRoot = temporaryDirectory("lark-taskboard-outside-");
    const outsideRepository = createGitRepository(outsideRoot);
    const escape = join(allowedRoot, "escape");
    symlinkSync(outsideRepository, escape);
    const third = administration.createProject({
      projectKey: "THIRD",
      name: "第三个项目",
      description: "",
    });
    await expect(
      registry.registerWorkspace(third.id, {
        absolutePath: escape,
        expectedVersion: third.version,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Project administration module", () => {
  it("applies versions, archival and audit in transactions", () => {
    const { administration, database } = setup();
    const created = administration.createProject({
      projectKey: "ADMIN",
      name: "管理项目",
      description: "初始描述",
    });
    const updated = administration.updateProject(created.id, {
      expectedVersion: created.version,
      name: "已更新项目",
    });

    expect(updated).toMatchObject({ name: "已更新项目", version: 2 });
    expect(() =>
      administration.updateProject(created.id, {
        expectedVersion: created.version,
        description: "过期写入",
      }),
    ).toThrowError(AppError);

    const archived = administration.archiveProject(created.id, {
      expectedVersion: updated.version,
    });
    expect(archived).toMatchObject({ version: 3 });
    expect(archived.archivedAt).not.toBeNull();
    expect(
      database.prepare("SELECT action FROM audit_events ORDER BY created_at, rowid").pluck().all(),
    ).toEqual(["project.create", "project.update", "project.archive"]);
  });
});
