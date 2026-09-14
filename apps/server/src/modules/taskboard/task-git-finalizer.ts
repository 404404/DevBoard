import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { AppError } from "../../app-error.js";
import { fingerprintWorkspace } from "./task-git-evidence.js";

const execute = promisify(execFile);
export type WorkspaceCommandRunner = (
  cwd: string,
  command: readonly string[],
  writableRoots: readonly string[],
) => Promise<string>;

export class WorkspaceNotGitError extends Error {}

export interface TaskGitSnapshot {
  readonly cwd: string;
  readonly commonDirectory: string;
  readonly mainCwd: string;
  readonly branch: string | null;
  readonly initialHead: string;
  readonly taskId: string;
  readonly archiveRef: string;
  readonly protectedCheckout: boolean;
  readonly commitSha: string | null;
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
  readonly notes: readonly string[];
  readonly verifiedFingerprint: string | null;
}

/** External steps are repeatable; the caller persists the returned checkpoint after each step. */
export class TaskGitFinalizer {
  readonly #allowedRoots: readonly string[];
  readonly #commandRunner: WorkspaceCommandRunner | undefined;

  constructor(allowedRoots: readonly string[], commandRunner?: WorkspaceCommandRunner) {
    this.#commandRunner = commandRunner;
    this.#allowedRoots = allowedRoots.map((root) => realpathSync(root));
  }

  async inspect(
    directory: string,
    taskId: string,
    operationId?: string,
  ): Promise<TaskGitSnapshot | null> {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("Invalid task identifier");
    if (operationId && !/^[a-zA-Z0-9-]+$/.test(operationId))
      throw new Error("Invalid operation identifier");
    let gitRoot: string;
    try {
      gitRoot = (await this.#git(directory, "rev-parse", "--show-toplevel")).trim();
    } catch (error) {
      if (error instanceof WorkspaceNotGitError) return null;
      throw error;
    }
    const cwd = this.#allowedDirectory(directory);
    const repositoryRoot = realpathSync(gitRoot);
    if (cwd !== repositoryRoot) {
      throw new AppError("INVALID_REQUEST", 409, "收尾目录必须是 Git 工作树根目录");
    }
    const commonDirectory = realpathSync(
      resolve(cwd, (await this.#git(cwd, "rev-parse", "--git-common-dir")).trim()),
    );
    const list = await this.#git(cwd, "worktree", "list", "--porcelain", "-z");
    const fields = list.split("\0");
    const mainPath = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!mainPath) throw new AppError("INVALID_REQUEST", 409, "无法确认主工作树");
    const mainCwd = this.#allowedDirectory(mainPath);
    const branch =
      (await this.#optionalGit(cwd, "symbolic-ref", "--quiet", "--short", "HEAD"))?.trim() || null;
    const mainBranch = (
      await this.#optionalGit(mainCwd, "symbolic-ref", "--quiet", "--short", "HEAD")
    )?.trim();
    const remoteDefault = (
      await this.#optionalGit(cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    )
      ?.trim()
      .replace("refs/remotes/origin/", "");
    return {
      cwd,
      commonDirectory,
      mainCwd,
      branch,
      taskId,
      initialHead: (await this.#git(cwd, "rev-parse", "--verify", "HEAD")).trim(),
      archiveRef: `refs/taskboard/completed/${taskId}${operationId ? `/${operationId}` : ""}`,
      protectedCheckout:
        cwd === mainCwd ||
        Boolean(branch && ["main", "master", "trunk", mainBranch, remoteDefault].includes(branch)),
      commitSha: null,
      worktreeRemoved: false,
      branchRemoved: false,
      notes: [],
      verifiedFingerprint: null,
    };
  }

  async commit(
    snapshot: TaskGitSnapshot,
    identifier: string,
    shared: boolean,
  ): Promise<TaskGitSnapshot> {
    this.#assertIdentity(snapshot);
    const head = (await this.#git(snapshot.cwd, "rev-parse", "HEAD")).trim();
    if (snapshot.commitSha) {
      if (head !== snapshot.commitSha)
        throw new AppError("VERSION_CONFLICT", 409, "收尾提交后工作树 HEAD 已变化");
      return snapshot;
    }
    const currentBranch =
      (
        await this.#optionalGit(snapshot.cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
      )?.trim() || null;
    if (currentBranch !== snapshot.branch)
      throw new AppError("VERSION_CONFLICT", 409, "收尾期间分支已变化");
    // A crash immediately after commit is recognized by its task-specific trailer.
    if (head !== snapshot.initialHead) {
      const message = await this.#git(snapshot.cwd, "log", "-1", "--format=%B");
      const parent = (await this.#git(snapshot.cwd, "rev-parse", "HEAD^")).trim();
      if (
        parent !== snapshot.initialHead ||
        !message.split("\n").includes(`Taskboard-Completion: ${snapshot.taskId}`)
      ) {
        throw new AppError("VERSION_CONFLICT", 409, "收尾期间出现其他提交，请检查工作树");
      }
    }
    const before = await this.#git(snapshot.cwd, "status", "--porcelain", "--untracked-files=all");
    if (shared && before.trim() && !snapshot.verifiedFingerprint)
      throw new AppError(
        "INVALID_REQUEST",
        409,
        "共享工作树存在未提交改动，无法确定任务归属，请先分离或提交相关改动",
      );
    if (
      before.trim() &&
      (!snapshot.verifiedFingerprint ||
        (await fingerprintWorkspace(snapshot.cwd, snapshot.taskId))?.fingerprint !==
          snapshot.verifiedFingerprint)
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        409,
        "存在无法确认任务归属的改动，或执行结束后文件已变化，请检查并提交后重试",
      );
    }
    await this.#removeTaskTemporaryFiles(snapshot);
    const status = await this.#git(snapshot.cwd, "status", "--porcelain", "--untracked-files=all");
    if (status.trim()) {
      if (head !== snapshot.initialHead)
        throw new AppError("VERSION_CONFLICT", 409, "收尾提交后又出现改动，请检查后重试");
      await this.#git(snapshot.cwd, "add", "--all", "--", ".");
      await this.#git(
        snapshot.cwd,
        "commit",
        "-m",
        `chore: 完成 ${identifier}`,
        "-m",
        `Taskboard-Completion: ${snapshot.taskId}`,
      );
    }
    if ((await this.#git(snapshot.cwd, "status", "--porcelain", "--untracked-files=all")).trim()) {
      throw new AppError("INVALID_REQUEST", 409, "提交后工作树仍有改动，收尾未完成");
    }
    const commitSha = (await this.#git(snapshot.cwd, "rev-parse", "HEAD")).trim();
    return { ...snapshot, commitSha };
  }

  async cleanup(snapshot: TaskGitSnapshot, shared: boolean): Promise<TaskGitSnapshot> {
    if (!snapshot.commitSha) throw new AppError("INVALID_REQUEST", 409, "必须先确认 Git 提交");
    this.#allowedDirectory(snapshot.mainCwd);
    const common = realpathSync(
      resolve(
        snapshot.mainCwd,
        (await this.#git(snapshot.mainCwd, "rev-parse", "--git-common-dir")).trim(),
      ),
    );
    if (common !== snapshot.commonDirectory)
      throw new AppError("VERSION_CONFLICT", 409, "Git 仓库已变化");
    const existingRef = (
      await this.#optionalGit(snapshot.mainCwd, "rev-parse", "--verify", snapshot.archiveRef)
    )?.trim();
    if (existingRef && existingRef !== snapshot.commitSha)
      throw new AppError("VERSION_CONFLICT", 409, "任务归档引用已存在其他提交");
    await this.#git(
      snapshot.mainCwd,
      "update-ref",
      snapshot.archiveRef,
      snapshot.commitSha,
      existingRef ?? "",
    );
    if (snapshot.worktreeRemoved && snapshot.branchRemoved) return snapshot;
    if (existsSync(snapshot.cwd)) {
      this.#assertIdentity(snapshot);
      const branch =
        (
          await this.#optionalGit(snapshot.cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
        )?.trim() || null;
      const repository = realpathSync(
        resolve(
          snapshot.cwd,
          (await this.#git(snapshot.cwd, "rev-parse", "--git-common-dir")).trim(),
        ),
      );
      if (branch !== snapshot.branch || repository !== snapshot.commonDirectory)
        throw new AppError("VERSION_CONFLICT", 409, "收尾期间工作树分支或仓库已变化");
      if (
        (await this.#git(snapshot.cwd, "rev-parse", "HEAD")).trim() !== snapshot.commitSha ||
        (await this.#git(snapshot.cwd, "status", "--porcelain", "--untracked-files=all")).trim()
      ) {
        throw new AppError("VERSION_CONFLICT", 409, "收尾提交后工作树已变化，请检查后重试");
      }
    } else if (shared || snapshot.protectedCheckout) {
      throw new AppError("VERSION_CONFLICT", 409, "需要保留的工作树已不存在");
    }
    if (shared || snapshot.protectedCheckout) {
      return {
        ...snapshot,
        notes: [shared ? "其他任务仍使用此工作树或分支，已保留" : "主工作树或默认分支已保留"],
      };
    }
    if (existsSync(snapshot.cwd)) {
      this.#assertIdentity(snapshot);
      const head = (await this.#git(snapshot.cwd, "rev-parse", "HEAD")).trim();
      if (head !== snapshot.commitSha)
        throw new AppError("VERSION_CONFLICT", 409, "清理前提交已变化");
      const status = await this.#git(
        snapshot.cwd,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
      );
      if (status.trim())
        throw new AppError("INVALID_REQUEST", 409, "工作树存在未归属或未提交的文件，请清理后重试");
      await this.#git(snapshot.mainCwd, "worktree", "remove", "--", snapshot.cwd);
    }
    let branchRemoved = snapshot.branchRemoved;
    if (snapshot.branch) {
      const ref = `refs/heads/${snapshot.branch}`;
      const current = (
        await this.#optionalGit(snapshot.mainCwd, "rev-parse", "--verify", ref)
      )?.trim();
      if (current) {
        if (current !== snapshot.commitSha)
          throw new AppError("VERSION_CONFLICT", 409, "待清理分支已变化");
        const worktrees = await this.#git(
          snapshot.mainCwd,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        );
        if (worktrees.split("\0").includes(`branch ${ref}`))
          throw new AppError("INVALID_REQUEST", 409, "其他工作树正在使用待清理分支");
        // CAS deletion only after the durable archive ref preserves the exact commit.
        await this.#git(snapshot.mainCwd, "update-ref", "-d", ref, current);
      }
      branchRemoved = true;
    }
    return { ...snapshot, worktreeRemoved: true, branchRemoved };
  }

  async #git(cwd: string, ...args: string[]): Promise<string> {
    if (this.#commandRunner)
      return this.#commandRunner(cwd, ["git", "-C", cwd, ...args], this.#allowedRoots);
    return git(cwd, ...args);
  }
  async #optionalGit(cwd: string, ...args: string[]): Promise<string | null> {
    try {
      return await this.#git(cwd, ...args);
    } catch {
      return null;
    }
  }

  #allowedDirectory(directory: string): string {
    const canonical = realpathSync(directory);
    if (!this.#allowedRoots.some((root) => inside(root, canonical)))
      throw new AppError("FORBIDDEN", 403, "收尾目录超出允许的工作区");
    return canonical;
  }

  #assertIdentity(snapshot: TaskGitSnapshot): void {
    if (this.#allowedDirectory(snapshot.cwd) !== snapshot.cwd)
      throw new AppError("VERSION_CONFLICT", 409, "工作树路径已变化");
  }

  async #removeTaskTemporaryFiles(snapshot: TaskGitSnapshot): Promise<void> {
    const relativePath = join(".tmp", "taskboard", snapshot.taskId);
    const path = join(snapshot.cwd, relativePath);
    if (!existsSync(path)) return;
    for (const part of [
      join(snapshot.cwd, ".tmp"),
      join(snapshot.cwd, ".tmp", "taskboard"),
      path,
    ]) {
      if (lstatSync(part).isSymbolicLink() || !inside(snapshot.cwd, realpathSync(part)))
        throw new AppError("INVALID_REQUEST", 409, "临时目录包含符号链接，无法清理");
    }
    if ((await this.#git(snapshot.cwd, "ls-files", "--", relativePath)).trim())
      throw new AppError("INVALID_REQUEST", 409, "任务临时目录包含已跟踪文件，无法自动清理");
    if (this.#commandRunner)
      await this.#commandRunner(snapshot.cwd, ["/bin/rm", "-r", "--", path], this.#allowedRoots);
    else await rm(path, { recursive: true });
    for (const parent of [join(snapshot.cwd, ".tmp", "taskboard"), join(snapshot.cwd, ".tmp")]) {
      if (this.#commandRunner) {
        if (existsSync(parent) && (await readdir(parent)).length === 0)
          await this.#commandRunner(snapshot.cwd, ["/bin/rmdir", parent], this.#allowedRoots);
        continue;
      }
      await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
      });
    }
  }
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    return (
      await execute("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  } catch (cause) {
    if (
      args[0] === "rev-parse" &&
      cause &&
      typeof cause === "object" &&
      "stderr" in cause &&
      String(cause.stderr).includes("not a git repository")
    )
      throw new WorkspaceNotGitError();
    throw new AppError("UPSTREAM_ERROR", 502, `Git 收尾步骤失败：${args[0]}`, { cause });
  }
}
