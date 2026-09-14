import { expect, it, vi } from "vitest";
import { hostWorkspaceCommand } from "../src/modules/taskboard/task-git-host-command.js";

it("runs fixed argv on the Codex host with workspace writes and no network", async () => {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "commit-sha", stderr: "" }),
  };
  const runner = hostWorkspaceCommand(client);
  await expect(
    runner(
      "/workspace/task",
      ["git", "-C", "/workspace/task", "commit", "-m", "task"],
      ["/workspace"],
    ),
  ).resolves.toBe("commit-sha");
  expect(client.connect).toHaveBeenCalledOnce();
  expect(client.request).toHaveBeenCalledWith(
    "command/exec",
    expect.objectContaining({
      command: ["git", "-C", "/workspace/task", "commit", "-m", "task"],
      cwd: "/workspace/task",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    }),
  );
});

it("keeps failed host commands recoverable without exposing repository stderr", async () => {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi
      .fn()
      .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "private repository contents" }),
  };
  await expect(
    hostWorkspaceCommand(client)("/workspace/task", ["git", "commit"], ["/workspace"]),
  ).rejects.toThrow("宿主机收尾命令失败：git");
});
