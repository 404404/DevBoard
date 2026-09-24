import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  process.stdout.write("codex fixture v0.1.0\n");
  process.exit(0);
}
if (
  process.argv[2] !== "app-server" ||
  process.argv[3] !== "--listen" ||
  process.argv[4] !== "stdio://"
) {
  process.stderr.write("unsupported fixture command\n");
  process.exit(2);
}

const threadId = "ssh-fixture-thread";
const turnId = "ssh-fixture-turn";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("invalid jsonl request\n");
    process.exit(3);
  }
  if (typeof message.id !== "string" && typeof message.id !== "number") return;
  if (typeof message.method !== "string") {
    if (message.id !== "ssh-fixture-approval") return;
    send({
      method: "serverRequest/resolved",
      params: { threadId, turnId, requestId: message.id },
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: "ssh-fixture-answer",
          type: "agentMessage",
          phase: "final_answer",
          text: `remote workspace ${process.cwd()} approved=${
            message.result?.decision === "accept"
          }`,
        },
      },
    });
    send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", error: null } },
    });
    return;
  }
  const result = (value) => send({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      result({ codexHome: "/home/devboard/.codex-fixture" });
      break;
    case "thread/start":
      result({ thread: { id: threadId }, cwd: message.params?.cwd ?? process.cwd() });
      break;
    case "thread/name/set":
    case "thread/unsubscribe":
      result({ status: "ok" });
      break;
    case "thread/resume":
      result({ thread: { id: message.params?.threadId ?? threadId } });
      break;
    case "turn/start":
      result({ turn: { id: turnId } });
      setImmediate(() => {
        send({
          method: "turn/started",
          params: { threadId, turn: { id: turnId, status: "inProgress" } },
        });
        send({
          jsonrpc: "2.0",
          id: "ssh-fixture-approval",
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, command: ["git", "status", "--short"], cwd: process.cwd() },
        });
      });
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not found" },
      });
  }
});
