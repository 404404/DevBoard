import { GitOriginLookupResultSchema } from "@codexboard/contracts";
import type { GitOriginReader } from "../project-registry/git-origin.js";
import { z } from "zod";
import { AppError } from "../../app-error.js";
import type { CodexJsonRpcClient } from "../codex/index.js";
import { WorkspaceNotGitError, type WorkspaceCommandRunner } from "./task-git-finalizer.js";

const Result = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });

/** Fixed argv is supplied only by the validated finalizer; no shell or model turn is used. */
export function hostWorkspaceCommand(
  client: Pick<CodexJsonRpcClient, "connect" | "request">,
): WorkspaceCommandRunner {
  return async (cwd, command, writableRoots) => {
    await client.connect();
    const result = Result.parse(
      await client.request("command/exec", {
        command: [...command],
        cwd,
        env: { LC_ALL: "C" },
        timeoutMs: 20_000,
        outputBytesCap: 4 * 1024 * 1024,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [...writableRoots],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      }),
    );
    if (
      result.exitCode !== 0 &&
      command[0] === "git" &&
      command[3] === "rev-parse" &&
      result.stderr.includes("not a git repository")
    )
      throw new WorkspaceNotGitError();
    if (result.exitCode !== 0) {
      if (
        command[0] === "git" &&
        /cannot lock ref|unable to create directory|[Pp]ermission denied|[Oo]peration not permitted/.test(
          result.stderr,
        )
      )
        throw new AppError("UPSTREAM_ERROR", 502, "Git 收尾无法写入仓库元数据，请检查工作区权限。");
      throw new AppError("UPSTREAM_ERROR", 502, `宿主机收尾命令失败：${command[0]}`);
    }
    return result.stdout;
  };
}

export function hostGitOriginReader(
  client: Pick<CodexJsonRpcClient, "connect" | "request">,
): GitOriginReader {
  return async (query) => {
    await client.connect();
    return GitOriginLookupResultSchema.parse(await client.request("taskboard/gitOrigins", query));
  };
}
