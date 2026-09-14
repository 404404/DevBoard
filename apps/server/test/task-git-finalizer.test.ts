import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { TaskGitFinalizer } from "../src/modules/taskboard/task-git-finalizer.js";
import { fingerprintWorkspace } from "../src/modules/taskboard/task-git-evidence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
async function inspectGit(finalizer: TaskGitFinalizer, cwd: string, taskId: string) {
  const snapshot = await finalizer.inspect(cwd, taskId);
  if (!snapshot) throw new Error("expected Git fixture");
  return snapshot;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "task-finalize-"));
  roots.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Taskboard Test");
  git(main, "config", "user.email", "taskboard@example.test");
  writeFileSync(join(main, "source.txt"), "before\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  const worktree = join(root, "worktree");
  git(main, "worktree", "add", "-b", "feature/task", worktree);
  const finalizer = new TaskGitFinalizer([root]);
  return { root, main, worktree, finalizer };
}

it("commits an exclusive worktree, preserves its commit under a task ref and removes its branch", async () => {
  const { main, worktree, finalizer } = setup();
  writeFileSync(join(worktree, "source.txt"), "finished\n");
  writeFileSync(join(worktree, "new-source.txt"), "new source\n");
  const snapshot = {
    ...(await inspectGit(finalizer, worktree, "task-one")),
    verifiedFingerprint: (await fingerprintWorkspace(worktree))!.fingerprint,
  };
  const committed = await finalizer.commit(snapshot, "TEST-1", false);
  expect(committed.commitSha).not.toBe(snapshot.initialHead);
  expect(git(worktree, "status", "--porcelain")).toBe("");
  const cleaned = await finalizer.cleanup(committed, false);
  expect(cleaned.worktreeRemoved).toBe(true);
  expect(cleaned.branchRemoved).toBe(true);
  expect(existsSync(worktree)).toBe(false);
  expect(git(main, "rev-parse", cleaned.archiveRef)).toBe(committed.commitSha);
  expect(git(main, "show", `${cleaned.archiveRef}:new-source.txt`)).toBe("new source");
  expect(await finalizer.cleanup(cleaned, false)).toEqual(cleaned);
});

it("refuses to commit changes without execution evidence even for the only task on main", async () => {
  const { main, finalizer } = setup();
  writeFileSync(join(main, "personal.txt"), "not task work\n");
  const snapshot = await inspectGit(finalizer, main, "task-unowned");
  await expect(finalizer.commit(snapshot, "TEST-5", false)).rejects.toThrow("归属");
  expect(git(main, "status", "--porcelain")).toContain("personal.txt");
});

it("revalidates a protected checkout before completing a resumed cleanup", async () => {
  const { main, finalizer } = setup();
  const snapshot = await finalizer.commit(
    await inspectGit(finalizer, main, "task-stale"),
    "TEST-6",
    false,
  );
  writeFileSync(join(main, "late.txt"), "arrived after commit\n");
  await expect(finalizer.cleanup(snapshot, false)).rejects.toThrow();
});

it("preserves a shared clean worktree and refuses to mix shared dirty work into a task commit", async () => {
  const { worktree, finalizer } = setup();
  const snapshot = await inspectGit(finalizer, worktree, "task-shared");
  writeFileSync(join(worktree, "source.txt"), "other task work\n");
  await expect(finalizer.commit(snapshot, "TEST-2", true)).rejects.toThrow("共享");
  git(worktree, "checkout", "--", "source.txt");
  const committed = await finalizer.commit(snapshot, "TEST-2", true);
  const cleaned = await finalizer.cleanup(committed, true);
  expect(cleaned.worktreeRemoved).toBe(false);
  expect(existsSync(worktree)).toBe(true);
});

it("keeps the main checkout and default branch", async () => {
  const { main, finalizer } = setup();
  const snapshot = await inspectGit(finalizer, main, "task-main");
  const result = await finalizer.cleanup(await finalizer.commit(snapshot, "TEST-3", false), false);
  expect(result.worktreeRemoved).toBe(false);
  expect(result.branchRemoved).toBe(false);
  expect(existsSync(main)).toBe(true);
});

it("cleans only the current task temporary namespace and refuses unknown ignored leftovers", async () => {
  const { worktree, finalizer } = setup();
  writeFileSync(join(worktree, ".gitignore"), ".tmp/\n");
  git(worktree, "add", ".gitignore");
  git(worktree, "commit", "-m", "ignore temp");
  mkdirSync(join(worktree, ".tmp", "taskboard", "task-temp"), { recursive: true });
  writeFileSync(join(worktree, ".tmp", "taskboard", "task-temp", "scratch"), "temporary");
  writeFileSync(join(worktree, ".tmp", "unowned"), "keep");
  const snapshot = await inspectGit(finalizer, worktree, "task-temp");
  const committed = await finalizer.commit(snapshot, "TEST-4", false);
  expect(existsSync(join(worktree, ".tmp", "taskboard", "task-temp"))).toBe(false);
  await expect(finalizer.cleanup(committed, false)).rejects.toThrow("未归属");
  expect(existsSync(join(worktree, ".tmp", "unowned"))).toBe(true);
});

it("keeps task source evidence stable when task temporary files are removed before retry", async () => {
  const { worktree, finalizer } = setup();
  writeFileSync(join(worktree, "source.txt"), "task change");
  const temporary = join(worktree, ".tmp", "taskboard", "task-retry");
  mkdirSync(temporary, { recursive: true });
  writeFileSync(join(temporary, "scratch"), "scratch");
  const snapshot = {
    ...(await inspectGit(finalizer, worktree, "task-retry")),
    verifiedFingerprint: (await fingerprintWorkspace(worktree, "task-retry"))!.fingerprint,
  };
  // Model a process stop after task-temp removal, before Git commit completes.
  rmSync(temporary, { recursive: true });
  const result = await finalizer.commit(snapshot, "TEST-7", false);
  expect(git(worktree, "show", "HEAD:source.txt")).toBe("task change");
  expect(result.commitSha).not.toBe(snapshot.initialHead);
});

it("treats unborn Git repositories as unavailable evidence without blocking dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "unborn-evidence-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  await expect(fingerprintWorkspace(root)).resolves.toBeNull();
});

it("rejects a branch switch at the same SHA during cleanup", async () => {
  const { worktree, finalizer } = setup();
  const snapshot = await finalizer.commit(
    await inspectGit(finalizer, worktree, "task-switch"),
    "TEST-8",
    false,
  );
  git(worktree, "switch", "-c", "feature/other");
  await expect(finalizer.cleanup(snapshot, false)).rejects.toThrow("分支或仓库");
  expect(existsSync(worktree)).toBe(true);
});

it("commits verified task changes while retaining a shared worktree", async () => {
  const { worktree, finalizer } = setup();
  writeFileSync(join(worktree, "source.txt"), "verified shared task work");
  const snapshot = {
    ...(await inspectGit(finalizer, worktree, "task-shared-evidence")),
    verifiedFingerprint: (await fingerprintWorkspace(worktree, "task-shared-evidence"))!
      .fingerprint,
  };
  const committed = await finalizer.commit(snapshot, "TEST-9", true);
  const cleaned = await finalizer.cleanup(committed, true);
  expect(git(worktree, "show", "HEAD:source.txt")).toBe("verified shared task work");
  expect(cleaned.worktreeRemoved).toBe(false);
  expect(existsSync(worktree)).toBe(true);
});

it("recognizes an existing non-Git task directory without changing its files", async () => {
  const root = mkdtempSync(join(tmpdir(), "plain-task-directory-"));
  roots.push(root);
  writeFileSync(join(root, "document.txt"), "deliverable");
  const finalizer = new TaskGitFinalizer([root]);
  await expect(finalizer.inspect(root, "plain-task")).resolves.toBeNull();
  expect(existsSync(join(root, "document.txt"))).toBe(true);
});
