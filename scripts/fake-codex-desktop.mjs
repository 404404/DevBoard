// Isolated Desktop owner used by browser tests. Never touches the user's IPC socket.
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const directory = join(process.env.FAKE_CODEX_HOME, "ipc");
mkdirSync(directory, { recursive: true });
const queues = {};
const saveQueues = () =>
  writeFileSync(
    join(process.env.FAKE_CODEX_HOME, ".codex-global-state.json"),
    JSON.stringify({ "queued-follow-ups": queues }),
  );
saveQueues();
const states = new Map();
const peers = new Map();
const send = (socket, message) => {
  if (socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  socket.write(Buffer.concat([prefix, body]));
};
const stateFor = (id) => {
  if (!states.has(id)) {
    let metadata = {};
    try {
      metadata = JSON.parse(
        readFileSync(join(process.env.FAKE_CODEX_HOME, "remote-threads", `${id}.json`), "utf8"),
      );
    } catch {
      /* Legacy fixture. */
    }
    states.set(id, {
      id,
      cwd: metadata.cwd ?? process.cwd(),
      title: "新任务",
      turns: [],
      requests: [],
      turnsPagination: { hasLoadedOldest: true },
    });
  }
  return states.get(id);
};
function publish(id) {
  const revision = Date.now();
  for (const [socket, following] of peers) {
    if (following !== id) continue;
    send(socket, {
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "fake-desktop",
      params: {
        hostId: "local",
        conversationId: id,
        change: { type: "snapshot", revision, conversationState: stateFor(id) },
      },
    });
  }
  return revision;
}
function complete(id, turnId, status) {
  const state = stateFor(id);
  const turn = state.turns.find((turn) => turn.turnId === turnId);
  if (!turn) return;
  turn.status = status;
  turn.items = [
    ...turn.items.filter((item) => item.type === "userMessage"),
    {
      id: `progress-${turnId}`,
      type: "agentMessage",
      phase: "commentary",
      text: "Fake Codex 执行前进度说明",
    },
    {
      id: `message-${turnId}`,
      type: "agentMessage",
      phase: status === "completed" ? "final_answer" : "commentary",
      text: status === "completed" ? "Fake Codex 已完成浏览器验收执行" : "Fake Codex 已中断",
    },
  ];
  state.requests = [];
  publish(id);
}
const server = createServer((socket) => {
  peers.set(socket, undefined);
  let buffer = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("close", () => peers.delete(socket));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
      const length = buffer.readUInt32LE();
      const m = JSON.parse(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
      const id = m.params?.conversationId;
      if (m.type === "broadcast") {
        peers.set(socket, m.params.following ? id : undefined);
        if (m.params.following) publish(id);
        continue;
      }
      let result = {};
      if (m.method === "initialize") result = { clientId: randomUUID() };
      else if (m.method === "thread-follower-start-turn") {
        const state = stateFor(id),
          turnId = `turn-${randomUUID()}`;
        state.cwd = m.params.turnStart.request.cwd;
        state.turns.push({
          params: m.params.turnStart.request,
          turnId,
          status: "inProgress",
          items: [
            {
              id: `user-${turnId}`,
              type: "userMessage",
              clientId: m.params.turnStart.request.clientUserMessageId,
              content: m.params.turnStart.request.input,
            },
          ],
        });
        state.latestModel = m.params.turnStart.request.model ?? "test-model";
        state.latestReasoningEffort = m.params.turnStart.request.effort ?? "medium";
        state.requests = [
          {
            id: `approval-${turnId}`,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: id,
              turnId,
              itemId: `command-${turnId}`,
              command: "npm test",
              reason: "浏览器验收需要运行测试",
            },
          },
        ];
        if (m.params.turnStart.request.input?.[0]?.text === "权限与引导验收") {
          state.requests = [
            {
              id: `permissions-${turnId}`,
              method: "item/permissions/requestApproval",
              params: {
                threadId: id,
                turnId,
                cwd: state.cwd,
                reason: "运行本次验证需要访问网络并写入测试报告",
                permissions: {
                  network: { enabled: true },
                  fileSystem: { read: null, write: ["/tmp/taskboard-report"] },
                },
              },
            },
          ];
        }
        if (m.params.turnStart.request.input?.[0]?.text === "实时消息显示验收") {
          const turn = state.turns.at(-1);
          const user = turn.items[0];
          turn.items = [
            {
              id: `working-${turnId}`,
              type: "agentMessage",
              phase: "commentary",
              text: "正在处理本次请求",
            },
          ];
          state.requests = [];
          setTimeout(() => {
            turn.items.unshift(user);
            publish(id);
          }, 2500);
        }
        result = { result: { turn: { id: turnId } } };
        publish(id);
      } else if (m.method === "thread-follower-set-queued-follow-ups-state") {
        queues[id] = m.params.state[id] ?? [];
        saveQueues();
      } else if (m.method === "thread-follower-permissions-request-approval-response") {
        const state = stateFor(id);
        const request = state.requests.find((r) => r.id === m.params.requestId);
        if (!request || !["turn", "session"].includes(m.params.response.scope))
          throw new Error("Invalid permission response");
        const granted = m.params.response.permissions;
        if (
          Object.keys(granted).length &&
          JSON.stringify(granted) !== JSON.stringify(request.params.permissions)
        )
          throw new Error("Expanded permissions");
        const turn = state.turns.find((t) => t.turnId === request.params.turnId);
        turn.items.push({
          id: `permission-record-${request.id}`,
          type: "permissionRequest",
          completed: true,
          permissions: request.params.permissions,
          reason: request.params.reason,
          response: m.params.response,
        });
        state.requests = [];
        publish(id);
      } else if (m.method === "thread-follower-steer-turn") {
        const state = stateFor(id),
          turn = state.turns.find((t) => t.status === "inProgress");
        if (!turn || state.requests.length || m.params.toolOutput)
          throw new Error("Invalid steering request");
        turn.items.push({
          id: `steered-${m.params.clientUserMessageId}`,
          type: "userMessage",
          clientId: m.params.clientUserMessageId,
          content: m.params.input,
        });
        result = { result: { turnId: turn.turnId } };
        publish(id);
      } else if (m.method === "thread-follower-command-approval-decision") {
        complete(
          id,
          m.params.requestId.slice("approval-".length),
          m.params.decision === "accept" ? "completed" : "interrupted",
        );
      } else if (m.method === "thread-follower-interrupt-turn") {
        setTimeout(
          () => complete(id, m.params.expectedTurnId, "interrupted"),
          Number(process.env.FAKE_CODEX_INTERRUPT_DELAY_MS ?? 0),
        );
      } else if (
        ["thread-follower-load-complete-history", "thread-follower-compact-thread"].includes(
          m.method,
        )
      ) {
        const revision = publish(id);
        if (m.method === "thread-follower-load-complete-history") result = { revision };
      } else if (m.method !== "thread-owner-discovery")
        throw new Error(`Unsupported fake Desktop request: ${m.method}`);
      send(socket, {
        type: "response",
        requestId: m.requestId,
        method: m.method,
        resultType: "success",
        handledByClientId: "fake-desktop",
        result,
      });
    }
  });
});
server.listen(join(directory, "ipc.sock"), () => process.send?.({ ready: true }));
process.once("SIGTERM", () => {
  for (const socket of peers.keys()) socket.destroy();
  server.close(() => process.exit(0));
});
