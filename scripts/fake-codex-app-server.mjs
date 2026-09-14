#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { WebSocketServer } from "ws";

const listenIndex = process.argv.indexOf("--listen");
const listenValue = listenIndex >= 0 ? process.argv[listenIndex + 1] : undefined;
const stdio = listenValue === "stdio://";
if (process.argv[2] !== "app-server" || (!stdio && !listenValue?.startsWith("unix://"))) {
  process.stderr.write("fake app-server requires: app-server --listen unix://<path>\n");
  process.exit(2);
}

const socketPath = stdio
  ? join(process.cwd(), ".data", "fake.sock")
  : listenValue.slice("unix://".length);
const interruptDelayMs = Number.parseInt(process.env.FAKE_CODEX_INTERRUPT_DELAY_MS ?? "0", 10);
if (!stdio && existsSync(socketPath)) unlinkSync(socketPath);
const server = createServer();
const webSocketServer = stdio ? new EventEmitter() : new WebSocketServer({ server });
const turns = new Map();
const archiveConflicts = new Set();
const archiveConflictPath = (threadId) =>
  process.env.LARK_CODEX_DATA_DIR
    ? join(process.env.LARK_CODEX_DATA_DIR, `fake-archive-conflict-${encodeURIComponent(threadId)}`)
    : null;
let primaryThreadId;

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

function complete(socket, turn, status = "completed") {
  send(socket, {
    method: "item/completed",
    params: {
      threadId: turn.threadId,
      turnId: turn.turnId,
      completedAtMs: Date.now(),
      item: {
        id: `message-${turn.turnId}`,
        type: "agentMessage",
        phase: status === "completed" ? "final_answer" : "commentary",
        text: status === "completed" ? "Fake Codex 已完成浏览器验收执行" : "Fake Codex 已中断",
      },
    },
  });
  send(socket, {
    method: "turn/completed",
    params: {
      threadId: turn.threadId,
      turn: { id: turn.turnId, status, error: null },
    },
  });
  turns.delete(turn.turnId);
}

webSocketServer.on("connection", (socket) => {
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.method === "initialize") {
      send(socket, {
        id: message.id,
        result: {
          userAgent: "fake-codex-e2e",
          codexHome: process.env.FAKE_CODEX_HOME ?? join(dirname(socketPath), "codex-home"),
        },
      });
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "account/rateLimits/read") {
      send(socket, {
        id: message.id,
        result: {
          rateLimits: {
            secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1800000000 },
          },
        },
      });
      return;
    }
    if (message.method === "model/list") {
      send(socket, {
        id: message.id,
        result: {
          data: [
            {
              model: "gpt-6-astra",
              displayName: "GPT-6 Astra",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "medium",
              serviceTiers: [{ id: "priority", name: "Fast" }],
            },
            {
              model: "test-model",
              displayName: "Test model",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "medium",
            },
          ],
          nextCursor: null,
        },
      });
      return;
    }
    if (message.method === "thread/list") {
      const directory = join(process.env.FAKE_CODEX_HOME, "remote-threads");
      const data = existsSync(directory)
        ? readdirSync(directory).map((name) =>
            JSON.parse(readFileSync(join(directory, name), "utf8")),
          )
        : [];
      send(socket, {
        id: message.id,
        result: {
          data: data.filter(
            (t) => !message.params.searchTerm || t.name.includes(message.params.searchTerm),
          ),
          nextCursor: null,
        },
      });
      return;
    }
    if (message.method === "command/exec") {
      const [executable, ...args] = message.params.command;
      execFile(
        executable,
        args,
        { cwd: message.params.cwd, encoding: "utf8", timeout: message.params.timeoutMs },
        (error, stdout, stderr) => {
          send(socket, {
            id: message.id,
            result: {
              exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              stdout,
              stderr,
            },
          });
        },
      );
      return;
    }
    if (message.method === "fs/createDirectory") {
      mkdirSync(message.params.path, { recursive: message.params.recursive ?? true });
      send(socket, { id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/start") {
      primaryThreadId = randomUUID();
      if (process.env.FAKE_CODEX_HOME) {
        const directory = join(process.env.FAKE_CODEX_HOME, "remote-threads");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, `${primaryThreadId}.json`),
          JSON.stringify({
            id: primaryThreadId,
            name: "新任务",
            preview: "",
            cwd: message.params.cwd ?? process.cwd(),
            updatedAt: Math.floor(Date.now() / 1000),
          }),
        );
      }
      send(socket, {
        id: message.id,
        result: {
          thread: { id: primaryThreadId },
          cwd: message.params.cwd ?? process.cwd(),
        },
      });
      return;
    }
    if (
      message.method === "thread/name/set" &&
      message.params.name?.includes("[archive-conflict]")
    ) {
      archiveConflicts.add(message.params.threadId);
      const path = archiveConflictPath(message.params.threadId);
      if (path) writeFileSync(path, "conflict");
    }
    if (message.method === "thread/name/set" && process.env.FAKE_CODEX_HOME) {
      appendFileSync(
        join(process.env.FAKE_CODEX_HOME, "session_index.jsonl"),
        JSON.stringify({ id: message.params.threadId, thread_name: message.params.name }) + "\n",
      );
      const path = join(
        process.env.FAKE_CODEX_HOME,
        "remote-threads",
        `${message.params.threadId}.json`,
      );
      if (existsSync(path)) {
        const metadata = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...metadata, name: message.params.name }));
      }
    }
    if (message.method === "thread/read") {
      send(socket, {
        id: message.id,
        result: { thread: { id: message.params.threadId, turns: [] } },
      });
      return;
    }
    if (
      message.method === "thread/archive" &&
      (archiveConflicts.has(message.params.threadId) ||
        existsSync(archiveConflictPath(message.params.threadId) ?? ""))
    ) {
      send(socket, {
        id: message.id,
        error: {
          code: -32600,
          message: `thread ${message.params.threadId} already has an active writer`,
        },
      });
      return;
    }
    if (
      message.method === "thread/name/set" ||
      message.method === "thread/archive" ||
      message.method === "thread/unsubscribe" ||
      message.method === "thread/section/move"
    ) {
      send(socket, { id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/resume") {
      send(socket, { id: message.id, result: { thread: { id: message.params.threadId } } });
      return;
    }
    if (message.method === "turn/start") {
      const turnId = `turn-${randomUUID()}`;
      const turn = { threadId: message.params.threadId, turnId };
      turns.set(turnId, turn);
      send(socket, { id: message.id, result: { turn: { id: turnId } } });
      queueMicrotask(() => {
        send(socket, {
          id: `approval-${turnId}`,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: turn.threadId,
            turnId,
            itemId: `command-${turnId}`,
            command: "npm test",
            reason: "浏览器验收需要运行测试",
          },
        });
      });
      return;
    }
    if (message.method === "turn/interrupt") {
      send(socket, { id: message.id, result: {} });
      const turn = turns.get(message.params.turnId);
      if (turn) setTimeout(() => complete(socket, turn, "interrupted"), interruptDelayMs);
      return;
    }
    if (typeof message.id === "string" && message.id.startsWith("approval-")) {
      const turnId = message.id.slice("approval-".length);
      const turn = turns.get(turnId);
      if (!turn) return;
      if (message.result?.decision === "accept") {
        queueMicrotask(() => complete(socket, turn));
      } else {
        queueMicrotask(() => complete(socket, turn, "interrupted"));
      }
    }
  });
});

if (stdio) {
  const socket = new EventEmitter();
  socket.send = (data) => process.stdout.write(`${data}\n`);
  webSocketServer.emit("connection", socket);
  createInterface({ input: process.stdin }).on("line", (line) =>
    socket.emit("message", Buffer.from(line)),
  );
} else server.listen(socketPath);
const shutdown = () =>
  stdio ? process.exit(0) : webSocketServer.close(() => server.close(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
