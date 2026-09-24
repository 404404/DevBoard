import { describe, expect, it } from "vitest";

import {
  buildSshArguments,
  buildSshRemoteCommand,
  quotePosixShell,
} from "../src/modules/execution/process-transports.js";

describe("SSH process transport", () => {
  it("quotes remote paths and arguments as literal POSIX shell values", () => {
    const command = buildSshRemoteCommand("/workspace/user's project", "codex", [
      "app-server",
      "--model",
      "model; touch /tmp/should-not-run",
    ]);
    expect(command).toContain("'/workspace/user'\"'\"'s project'");
    expect(command).toContain("'model; touch /tmp/should-not-run'");
    expect(command).not.toContain("&& touch /tmp/should-not-run");
    expect(quotePosixShell("a'b")).toBe("'a'\"'\"'b'");
  });

  it("requires strict host-key verification and never puts a private key in the remote command", () => {
    const args = buildSshArguments({
      host: "remote.example.com",
      username: "runner",
      port: 2222,
      identity: "/Users/me/.ssh/id_ed25519",
      executable: "codex",
      args: ["app-server"],
      cwd: "/workspace/project",
    });
    expect(args).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/var/lib/devboard/ssh/known_hosts",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "-i",
      "/Users/me/.ssh/id_ed25519",
      "-o",
      "IdentitiesOnly=yes",
      "--",
      "runner@remote.example.com",
      "cd '/workspace/project' && exec 'codex' 'app-server'",
    ]);
    expect(args.join(" ")).not.toContain("PRIVATE KEY");
  });

  it("rejects unsafe SSH destinations", () => {
    expect(() =>
      buildSshArguments({
        host: "-oProxyCommand=unsafe",
        executable: "codex",
        args: ["app-server"],
        cwd: "/workspace/project",
      }),
    ).toThrow();
    expect(() => buildSshRemoteCommand("relative/path", "codex")).toThrow();
  });
});
