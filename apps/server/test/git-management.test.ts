import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { ProjectAdministration, ProjectRegistry } from "../src/modules/project-registry/index.js";
import { GitOrigins } from "../src/modules/project-registry/git-origin.js";
import { GitManagement } from "../src/modules/project-registry/git-management.js";

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-manager-test-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.test");
  writeFileSync(join(cwd, ".gitignore"), ".worktrees/\nignored.txt\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  const db: SqliteDatabase = initializeDatabase(":memory:");
  cleanup.push(() => db.close());
  const project = new ProjectAdministration(db).createProject({
    projectKey: "GIT",
    name: "Git",
    description: "",
  });
  const registry = new ProjectRegistry(db, [root]);
  await registry.registerWorkspace(project.id, {
    absolutePath: cwd,
    expectedVersion: project.version,
  });
  const manager = new GitManagement(db, registry, [root]);
  return { root, cwd, db, project, registry, manager };
}
it("creates branches and worktrees, refreshes executable contexts, removes only merged clean worktrees", async () => {
  const { manager, project, cwd, registry } = await setup();
  await manager.create(project.id, { kind: "branch", branch: "feature/ready", baseBranch: "main" });
  let view = await manager.read(project.id);
  expect(view.entries.find((e) => e.branch === "feature/ready")).toMatchObject({
    path: null,
    deleteReason: null,
  });
  await manager.create(project.id, {
    kind: "worktree",
    branch: "feature/ready",
    directoryName: "ready",
    existingBranch: true,
  });
  expect(registry.readDevelopmentContexts(project.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        branch: "feature/ready",
        worktreeRealpath: join(cwd, ".worktrees/ready"),
      }),
    ]),
  );
  view = await manager.read(project.id);
  const entry = view.entries.find((e) => e.branch === "feature/ready")!;
  expect(entry.deleteReason).toBeNull();
  await manager.remove(project.id, {
    branch: entry.branch,
    path: entry.path,
    expectedHead: entry.headSha,
  });
  expect(git(cwd, "branch", "--list", "feature/ready")).toBe("");
  expect((await manager.read(project.id)).entries).toHaveLength(1);
});
it("protects primary checkouts and rejects stale head, unmerged work, untracked files and locks", async () => {
  const { manager, project, cwd } = await setup();
  const primary = (await manager.read(project.id)).entries[0]!;
  await expect(
    manager.remove(project.id, {
      branch: primary.branch,
      path: primary.path,
      expectedHead: primary.headSha,
    }),
  ).rejects.toThrow(/主/);
  await manager.create(project.id, {
    kind: "worktree",
    branch: "feature/safe",
    baseBranch: "main",
    directoryName: "safe",
  });
  const path = join(cwd, ".worktrees/safe");
  let entry = (await manager.read(project.id)).entries.find((e) => e.branch === "feature/safe")!;
  await expect(
    manager.remove(project.id, { branch: entry.branch, path, expectedHead: "0".repeat(40) }),
  ).rejects.toThrow(/变化/);
  writeFileSync(join(path, "untracked.txt"), "keep me");
  entry = (await manager.read(project.id)).entries.find((e) => e.branch === "feature/safe")!;
  expect(entry.dirty).toBe(true);
  expect(entry.deleteReason).toMatch(/未提交|未跟踪/);
  await expect(
    manager.remove(project.id, { branch: entry.branch, path, expectedHead: entry.headSha }),
  ).rejects.toThrow(/未提交|未跟踪/);
  rmSync(join(path, "untracked.txt"));
  git(cwd, "worktree", "lock", path);
  expect(
    (await manager.read(project.id)).entries.find((e) => e.branch === "feature/safe")?.deleteReason,
  ).toMatch(/锁定/);
  git(cwd, "worktree", "unlock", path);
  writeFileSync(join(path, "new.txt"), "unmerged");
  git(path, "add", ".");
  git(path, "commit", "-m", "work");
  entry = (await manager.read(project.id)).entries.find((e) => e.branch === "feature/safe")!;
  expect(entry.deleteReason).toMatch(/合并/);
  await expect(
    manager.remove(project.id, { branch: entry.branch, path, expectedHead: entry.headSha }),
  ).rejects.toThrow(/合并/);
});
it("validates branch names, duplicate names, paths and symlink escapes", async () => {
  const { manager, project, cwd, root } = await setup();
  await expect(
    manager.create(project.id, { kind: "branch", branch: "--bad", baseBranch: "main" }),
  ).rejects.toThrow();
  await expect(
    manager.create(project.id, { kind: "branch", branch: "main", baseBranch: "main" }),
  ).rejects.toThrow(/已存在/);
  await expect(
    manager.create(project.id, {
      kind: "worktree",
      branch: "feature/bad",
      baseBranch: "main",
      directoryName: "../escape",
    }),
  ).rejects.toThrow();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(cwd, ".worktrees"));
  await expect(
    manager.create(project.id, {
      kind: "worktree",
      branch: "feature/bad",
      baseBranch: "main",
      directoryName: "bad",
    }),
  ).rejects.toThrow(/符号链接/);
  expect(git(cwd, "branch", "--list", "feature/bad")).toBe("");
});
it("keeps detached worktrees visible and protects their unmerged commits", async () => {
  const { manager, project, cwd } = await setup();
  const path = join(cwd, ".worktrees/detached");
  git(cwd, "worktree", "add", "--detach", path, "HEAD");
  writeFileSync(join(path, "keep.txt"), "keep");
  git(path, "add", ".");
  git(path, "commit", "-m", "detached work");
  const entry = (await manager.read(project.id)).entries.find((e) => e.path === path)!;
  expect(entry.branch).toBeNull();
  expect(entry.deleteReason).toMatch(/合并/);
});

it("blocks deletion while an active task references the branch", async () => {
  const { manager, project, db } = await setup();
  await manager.create(project.id, {
    kind: "worktree",
    branch: "feature/occupied",
    baseBranch: "main",
    directoryName: "occupied",
  });
  db.prepare(
    "INSERT INTO tasks (id, identifier, project_id, task_number, title, status, development_context_json) VALUES (?, ?, ?, 1, '占用任务', 'todo', ?)",
  ).run("task-occupied", "GIT-001", project.id, JSON.stringify({ branch: "feature/occupied" }));
  const entry = (await manager.read(project.id)).entries.find(
    (e) => e.branch === "feature/occupied",
  )!;
  expect(entry.taskCount).toBe(1);
  await expect(
    manager.remove(project.id, {
      branch: entry.branch,
      path: entry.path,
      expectedHead: entry.headSha,
    }),
  ).rejects.toThrow(/任务/);
});

it("shares its repository lock with task creation and releases it on failure", async () => {
  const { manager, project, db, cwd } = await setup();
  const { acquireGitManagementLock, assertWorkspaceLifecycleAvailable } =
    await import("../src/modules/taskboard/task-lifecycle-guard.js");
  const release = acquireGitManagementLock(db, cwd);
  expect(() => assertWorkspaceLifecycleAvailable(db, cwd)).toThrow(/管理分支/);
  await expect(
    manager.create(project.id, { kind: "branch", branch: "feature/locked", baseBranch: "main" }),
  ).rejects.toThrow(/管理分支/);
  release();
  await expect(
    manager.create(project.id, { kind: "branch", branch: "main", baseBranch: "main" }),
  ).rejects.toThrow(/已存在/);
  expect(() => assertWorkspaceLifecycleAvailable(db, cwd)).not.toThrow();
});

it("rejects unknown projects, non-Git folders and unignored worktree directories", async () => {
  const { manager, project, cwd } = await setup();
  await expect(manager.read("missing")).rejects.toThrow(/项目/);
  writeFileSync(join(cwd, ".gitignore"), "");
  await expect(
    manager.create(project.id, {
      kind: "worktree",
      branch: "feature/unsafe",
      baseBranch: "main",
      directoryName: "unsafe",
    }),
  ).rejects.toThrow(/gitignore/);
});

it("reports tracked changes and untracked files even when ignored files exist", async () => {
  const { manager, project, cwd } = await setup();
  writeFileSync(join(cwd, "ignored.txt"), "ignored");
  expect((await manager.read(project.id)).entries[0]?.dirty).toBe(false);
  writeFileSync(join(cwd, "untracked.txt"), "new");
  expect((await manager.read(project.id)).entries[0]?.dirty).toBe(true);
  rmSync(join(cwd, "untracked.txt"));
  writeFileSync(join(cwd, ".gitignore"), ".worktrees/\nignored.txt\nother.txt\n");
  expect((await manager.read(project.id)).entries[0]?.dirty).toBe(true);
});

it("removes merged worktrees containing only ignored files", async () => {
  const { manager, project, cwd } = await setup();
  await manager.create(project.id, {
    kind: "worktree",
    branch: "feature/ignored",
    baseBranch: "main",
    directoryName: "ignored",
  });
  const path = join(cwd, ".worktrees/ignored");
  writeFileSync(join(path, "ignored.txt"), "generated cache");
  const entry = (await manager.read(project.id)).entries.find((e) => e.path === path)!;
  expect(entry.dirty).toBe(false);
  expect(entry.deleteReason).toBeNull();
  await manager.remove(project.id, {
    branch: entry.branch,
    path,
    expectedHead: entry.headSha,
  });
  expect(existsSync(path)).toBe(false);
  expect(git(cwd, "branch", "--list", "feature/ignored")).toBe("");
});

it("preserves tracked changes even when their file name matches an ignore rule", async () => {
  const { manager, project, cwd } = await setup();
  writeFileSync(join(cwd, "ignored.txt"), "tracked content");
  git(cwd, "add", "-f", "ignored.txt");
  git(cwd, "commit", "-m", "track ignored file");
  await manager.create(project.id, {
    kind: "worktree",
    branch: "feature/tracked",
    baseBranch: "main",
    directoryName: "tracked",
  });
  const path = join(cwd, ".worktrees/tracked");
  writeFileSync(join(path, "ignored.txt"), "uncommitted change");
  const entry = (await manager.read(project.id)).entries.find((e) => e.path === path)!;
  await expect(
    manager.remove(project.id, {
      branch: entry.branch,
      path,
      expectedHead: entry.headSha,
    }),
  ).rejects.toThrow(/未提交/);
  expect(existsSync(path)).toBe(true);
  expect(git(cwd, "branch", "--list", "feature/tracked")).toContain("feature/tracked");
});

it("keeps separate branch and worktree creators and forgets deleted resource incarnations", async () => {
  const { manager, project, cwd, db } = await setup();
  const key = JSON.stringify(["feishu", "tenant", "user"]);
  db.prepare(
    "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', 'tenant', 'user', '严启鹏', 'admin')",
  ).run(key);
  const user = { kind: "user" as const, userKey: key, userName: "严启鹏" };
  await manager.create(
    project.id,
    { kind: "branch", branch: "feature/origin", baseBranch: "main" },
    key,
    user,
  );
  await manager.create(
    project.id,
    { kind: "worktree", branch: "feature/origin", directoryName: "origin", existingBranch: true },
    undefined,
    { kind: "terminal" },
  );
  let entry = (await manager.read(project.id)).entries.find((e) => e.branch === "feature/origin")!;
  expect(entry.branchOrigin).toMatchObject(user);
  expect(entry.worktreeOrigin).toMatchObject({ kind: "terminal" });
  await manager.remove(project.id, {
    branch: entry.branch,
    path: entry.path,
    expectedHead: entry.headSha,
  });
  git(cwd, "branch", "feature/origin", "main");
  entry = (await manager.read(project.id)).entries.find((e) => e.branch === "feature/origin")!;
  expect(entry.branchOrigin).toEqual({ kind: "unknown" });
});

it("records Codex thread provenance and treats unrecorded Git resources as unknown", async () => {
  const { manager, project, cwd } = await setup();
  const origin = {
    kind: "codex" as const,
    threadId: "11111111-1111-4111-8111-111111111111",
    threadTitle: "修复删除",
  };
  await manager.create(
    project.id,
    { kind: "worktree", branch: "feature/codex", baseBranch: "main", directoryName: "codex" },
    undefined,
    origin,
  );
  git(cwd, "branch", "feature/external", "main");
  const view = await manager.read(project.id);
  expect(view.entries.find((e) => e.branch === "feature/codex")?.branchOrigin).toMatchObject(
    origin,
  );
  expect(view.entries.find((e) => e.branch === "feature/codex")?.worktreeOrigin).toMatchObject(
    origin,
  );
  expect(view.entries.find((e) => e.branch === "feature/external")?.branchOrigin).toEqual({
    kind: "unknown",
  });
});

it("refreshes persisted Codex titles without duplicating creation audit records", async () => {
  const { db, project, cwd } = await setup();
  const resource = {
    key: "known",
    kind: "branch" as const,
    branch: "feature/test",
    path: null,
    createdAt: new Date().toISOString(),
  };
  const threadId = "11111111-1111-4111-8111-111111111111";
  let title = "实现 iPhone Codex 功能";
  const origins = new GitOrigins(db, async (query) => {
    expect(query.resources[0]).toMatchObject({ threadId });
    return { known: { kind: "codex", threadId, threadTitle: title } };
  });
  origins.record(project.id, resource, { kind: "codex", threadId, threadTitle: "old prompt" });
  expect((await origins.read(project.id, cwd, [resource])).known).toMatchObject({
    threadTitle: title,
  });
  title = "改名后的标题";
  expect((await origins.read(project.id, cwd, [resource])).known).toMatchObject({
    threadTitle: title,
  });
  expect(
    db.prepare("SELECT COUNT(*) FROM audit_events WHERE action = 'git.origin'").pluck().get(),
  ).toBe(1);
});
