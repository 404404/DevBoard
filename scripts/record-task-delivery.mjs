import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit handoff evidence for an authorized external Git delivery. No task/database writes.
export function recordTaskDelivery({ main, taskId, cwd, branch, commitSha }) {
  if (!/^[a-zA-Z0-9-]+$/.test(taskId) || !/^[a-f0-9]{40,64}$/.test(commitSha) || !isAbsolute(cwd))
    throw new Error("需要任务 ID、工作树绝对路径和完整交付提交 SHA");
  main = realpathSync(main);
  const git = (...args) => execFileSync("git", ["-C", main, ...args], { encoding: "utf8" }).trim();
  const fields = git("worktree", "list", "--porcelain", "-z").split("\0");
  if (fields.find((f) => f.startsWith("worktree ")) !== `worktree ${main}`)
    throw new Error("必须从主工作树记录交付");
  if (
    resolve(cwd) === main ||
    ["main", "master", "trunk", git("branch", "--show-current")].includes(branch)
  )
    throw new Error("不能记录主工作树或受保护分支的外部清理");
  git("check-ref-format", `refs/heads/${branch}`);
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("主工作区不干净");
  if (git("merge-base", "HEAD", commitSha) !== commitSha) throw new Error("交付提交尚未合并");
  if (existsSync(cwd)) {
    const taskGit = (...args) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    if (
      taskGit("rev-parse", "HEAD") !== commitSha ||
      taskGit("branch", "--show-current") !== branch ||
      taskGit("status", "--porcelain", "--untracked-files=all")
    )
      throw new Error("工作树与交付提交不一致或尚未提交");
    if (
      realpathSync(resolve(cwd, taskGit("rev-parse", "--git-common-dir"))) !==
      realpathSync(resolve(main, git("rev-parse", "--git-common-dir")))
    )
      throw new Error("工作树属于其他仓库");
  } else if (
    fields.includes(`worktree ${cwd}`) ||
    git("for-each-ref", "--format=%(refname)", `refs/heads/${branch}`)
      .split("\n")
      .includes(`refs/heads/${branch}`)
  ) {
    throw new Error("工作树已丢失但 Git 登记或任务分支仍存在");
  }
  const input = JSON.stringify({ taskId, cwd: resolve(cwd), branch, commitSha });
  const blob = execFileSync("git", ["-C", main, "hash-object", "-w", "--stdin"], {
    input,
    encoding: "utf8",
  }).trim();
  const ref = `refs/taskboard/delivered/${taskId}`;
  const existing = git("for-each-ref", "--format=%(refname) %(objectname)", ref)
    .split("\n")
    .find((line) => line.startsWith(`${ref} `))
    ?.split(" ")[1];
  if (existing && existing !== blob) throw new Error("已有不同交付记录，请先核对，不能覆盖");
  if (!existing) git("update-ref", ref, blob, "0".repeat(blob.length));
  return { ref, commitSha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [main, taskId, cwd, branch, commitSha] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(recordTaskDelivery({ main, taskId, cwd, branch, commitSha })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
