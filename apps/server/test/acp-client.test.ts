import { describe, expect, it } from "vitest";

import type { CodexTransport, JsonRpcMessage } from "../src/modules/codex/protocol.js";
import { AcpClient } from "../src/modules/execution/acp-client.js";

class FakeAcpTransport implements CodexTransport {
  readonly description = "fake-acp";
  readonly sent: JsonRpcMessage[] = [];
  #messageListener: ((message: unknown) => void) | undefined;
  #closeListener: ((error?: Error) => void) | undefined;
  readonly loadSession: boolean;

  constructor(loadSession = true) {
    this.loadSession = loadSession;
  }

  async connect(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if (!("id" in message) || !("method" in message)) return;
    const result =
      message.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: { loadSession: this.loadSession } }
        : message.method === "session/new"
          ? { sessionId: "session-1" }
          : {};
    this.#messageListener?.({ jsonrpc: "2.0", id: message.id, result });
  }

  async close(): Promise<void> {
    this.#closeListener?.();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListener = listener;
    return () => {
      if (this.#messageListener === listener) this.#messageListener = undefined;
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListener = listener;
    return () => {
      if (this.#closeListener === listener) this.#closeListener = undefined;
    };
  }
}

describe("ACP client", () => {
  it("uses JSON-RPC 2.0 and sends session/cancel as a notification", async () => {
    const transport = new FakeAcpTransport();
    const client = new AcpClient({ transport });

    await client.connect();
    const session = await client.newSession({ cwd: "/workspace/project" });
    await client.cancel(session.sessionId);

    expect(transport.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    });
    expect(session.sessionId).toBe("session-1");
    expect(transport.sent.at(-1)).toMatchObject({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session-1" },
    });
    expect(transport.sent.at(-1)).not.toHaveProperty("id");

    await client.close();
  });

  it("does not call session/load when the agent omits its capability", async () => {
    const transport = new FakeAcpTransport(false);
    const client = new AcpClient({ transport });

    await client.connect();
    await expect(
      client.loadSession({ sessionId: "old-session", cwd: "/workspace/project" }),
    ).rejects.toThrow("loadSession");
    expect(transport.sent.some((message) => "method" in message && message.method === "session/load")).toBe(
      false,
    );

    await client.close();
  });
});
