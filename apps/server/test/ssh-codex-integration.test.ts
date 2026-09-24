import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CodexProvider } from "../src/modules/execution/codex-provider.js";
import type { ProviderConnectionContext } from "../src/modules/execution/execution-provider.js";

const enabled = Boolean(
  process.env.DEVBOARD_SSH_FIXTURE_HOST &&
  process.env.DEVBOARD_SSH_FIXTURE_PORT &&
  process.env.DEVBOARD_SSH_FIXTURE_KEY &&
  process.env.DEVBOARD_SSH_FIXTURE_KNOWN_HOSTS,
);

describe.skipIf(!enabled)("Codex over disposable SSH Host", () => {
  function connection(
    knownHostsFile = process.env.DEVBOARD_SSH_FIXTURE_KNOWN_HOSTS ?? "/nonexistent/known_hosts",
  ): ProviderConnectionContext {
    return {
      id: "ssh-fixture-connection",
      type: "ssh_host",
      host: process.env.DEVBOARD_SSH_FIXTURE_HOST ?? "127.0.0.1",
      port: Number(process.env.DEVBOARD_SSH_FIXTURE_PORT),
      username: process.env.DEVBOARD_SSH_FIXTURE_USERNAME ?? "devboard",
      authMode: "identity_file",
      identityFilePath: process.env.DEVBOARD_SSH_FIXTURE_KEY ?? null,
      knownHostsFile,
    };
  }

  it("discovers Codex and streams an approved, completed turn through SSH stdio", async () => {
    const workspace = process.env.DEVBOARD_SSH_FIXTURE_WORKSPACE ?? "/home/devboard/workspace";
    expect(existsSync(workspace)).toBe(false);
    const sshConnection = connection();
    const provider = new CodexProvider();
    try {
      const health = await provider.health({ connection: sshConnection, workspace });
      expect(health).toMatchObject({ status: "ready", version: "codex fixture v0.1.0" });

      const session = await provider.createSession({ connection: sshConnection, workspace });
      expect(session).toMatchObject({
        providerKind: "codex",
        connectionId: "ssh-fixture-connection",
        workspace,
        resumable: true,
      });

      const events: Array<{ type: string; payload?: Readonly<Record<string, unknown>> }> = [];
      let approvals = 0;
      const result = await provider.execute(
        {
          connection: sshConnection,
          session,
          workspace,
          prompt: "Run the SSH protocol fixture",
          metadata: { runId: "ssh-fixture-run" },
        },
        {
          onEvent: (event) => events.push(event),
          onApproval: async () => {
            approvals += 1;
            return { type: "approve" };
          },
        },
      );

      expect(approvals).toBe(1);
      expect(result).toMatchObject({ status: "succeeded", session: { id: session.id } });
      expect(events.some((event) => event.type === "approval.resolved")).toBe(true);
      const answer = events.find((event) => event.type === "agent.message");
      expect(answer?.payload?.text).toContain("/home/devboard/workspace");
      expect(answer?.payload?.text).toContain("approved=true");
    } finally {
      await provider.dispose();
    }
  });

  it("requires explicit host-key trust and fails closed when the host key changes", async () => {
    const provider = new CodexProvider();
    try {
      const untrusted = await provider.health({
        connection: connection(
          process.env.DEVBOARD_SSH_FIXTURE_EMPTY_KNOWN_HOSTS ?? "/nonexistent/empty-known-hosts",
        ),
        workspace: "/home/devboard/workspace",
      });
      expect(untrusted.status).toBe("host_key_untrusted");

      const changedKnownHosts = process.env.DEVBOARD_SSH_FIXTURE_CHANGED_KNOWN_HOSTS;
      expect(changedKnownHosts).toBeTruthy();
      const changed = await provider.health({
        connection: connection(changedKnownHosts ?? "/nonexistent/changed-known-hosts"),
        workspace: "/home/devboard/workspace",
      });
      expect(changed.status).toBe("host_key_changed");
    } finally {
      await provider.dispose();
    }
  });
});
