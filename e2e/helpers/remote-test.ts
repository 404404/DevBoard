import { randomUUID } from "node:crypto";

import { test as base } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

// UI-only contract fixture. Server protocol/auth tests and SSH/Codex execution
// acceptance run separately; this fixture is not evidence of a live provider.
interface FixtureItem {
  id: string;
  type: string;
  text: string;
  detail: string;
  phase?: string;
  status?: string;
}

interface FixtureTurn {
  id: string;
  status: string;
  startedAtMs: number | null;
  durationMs: number | null;
  diff: string;
  error: string;
  items: FixtureItem[];
}

interface FixtureRequest {
  id: string;
  kind: "command" | "permissions";
  title: string;
  detail: string;
  decisions: Array<"accept" | "acceptForSession" | "decline" | "cancel">;
  questions: [];
  permissionReason?: string;
  permissionDescription?: string;
  permissionCwd?: string;
  permissionToken?: string;
}

interface FixtureThread {
  id: string;
  title: string;
  cwd: string;
  model: string;
  effort: string;
  status: string;
  activeTurnId: string | null;
  historyComplete: boolean;
  turns: FixtureTurn[];
  requests: FixtureRequest[];
  editableMessage: { turnId: string; itemId: string; token: string } | null;
  queue: {
    available: boolean;
    token: string;
    messages: Array<{
      id: string;
      text: string;
      createdAt: number;
      pausedReason: string | null;
      canEdit: boolean;
      canSteer: boolean;
    }>;
  };
}

type FixtureAction = { type: string; [key: string]: unknown };

function createThread(id: string): FixtureThread {
  return {
    id,
    title: "新任务",
    cwd: "/tmp/devboard-e2e",
    model: "test-model",
    effort: "medium",
    status: "idle",
    activeTurnId: null,
    historyComplete: true,
    turns: [],
    requests: [],
    editableMessage: null,
    queue: { available: true, token: "a".repeat(64), messages: [] },
  };
}

function addTurn(thread: FixtureThread, text: string): FixtureTurn {
  const id = `turn-${randomUUID()}`;
  const turn: FixtureTurn = {
    id,
    status: "inProgress",
    startedAtMs: Date.now(),
    durationMs: null,
    diff: "",
    error: "",
    items: [{ id: `user-${id}`, type: "userMessage", text, detail: "" }],
  };
  thread.turns.push(turn);
  thread.activeTurnId = id;
  thread.status = "active";
  return turn;
}

function requestFor(text: string, turnId: string): FixtureRequest {
  if (text === "权限与引导验收") {
    return {
      id: `permissions-${turnId}`,
      kind: "permissions",
      title: "需要访问权限",
      detail: "访问网络\n写入：/tmp/taskboard-report",
      permissionReason: "运行本次验证需要访问网络并写入测试报告",
      permissionDescription: "访问网络\n写入：/tmp/taskboard-report",
      permissionCwd: "/tmp/devboard-e2e",
      permissionToken: "b".repeat(64),
      decisions: ["accept", "acceptForSession", "decline"],
      questions: [],
    };
  }
  return {
    id: `approval-${turnId}`,
    kind: "command",
    title: "需要批准命令",
    detail: "npm test",
    decisions: ["accept", "acceptForSession", "decline", "cancel"],
    questions: [],
  };
}

function applyAction(thread: FixtureThread, action: FixtureAction): void {
  if (action.type === "rename" && typeof action.name === "string") {
    thread.title = action.name;
    return;
  }
  if (action.type === "send" || action.type === "steer") {
    const text = typeof action.text === "string" ? action.text : "";
    const turn = thread.status === "active" ? thread.turns.at(-1) : undefined;
    const target = turn ?? addTurn(thread, text);
    if (turn)
      target.items.push({ id: `user-${randomUUID()}`, type: "userMessage", text, detail: "" });
    thread.requests = [requestFor(text, target.id)];
    return;
  }
  if (action.type === "respond") {
    const request = thread.requests.find((candidate) => candidate.id === action.requestId);
    const turn = thread.turns.find((candidate) => candidate.id === thread.activeTurnId);
    if (action.decision === "accept" || action.decision === "acceptForSession") {
      if (request?.kind !== "permissions" && turn) {
        turn.status = "completed";
        turn.durationMs = 1;
        turn.items.push({
          id: `final-${turn.id}`,
          type: "agentMessage",
          text: "Fake Codex 已完成浏览器验收执行",
          detail: "",
          phase: "final_answer",
        });
      }
      if (request?.kind !== "permissions") {
        thread.status = "idle";
        thread.activeTurnId = null;
      }
    }
    thread.requests = [];
    return;
  }
  if (action.type === "stop") {
    const turn = thread.turns.find((candidate) => candidate.id === action.turnId);
    if (turn) {
      turn.status = "interrupted";
      turn.durationMs = 1;
      turn.items.push({
        id: `stopped-${turn.id}`,
        type: "agentMessage",
        text: "Fake Codex 已中断",
        detail: "已停止",
        phase: "commentary",
      });
    }
    thread.requests = [];
    thread.status = "idle";
    thread.activeTurnId = null;
    return;
  }
  if (action.type === "queue") {
    const id = typeof action.messageId === "string" ? action.messageId : `queue-${randomUUID()}`;
    if (action.operation === "append") {
      thread.queue.messages.push({
        id,
        text: typeof action.text === "string" ? action.text : "",
        createdAt: Date.now(),
        pausedReason: null,
        canEdit: true,
        canSteer: true,
      });
    } else if (action.operation === "edit") {
      const message = thread.queue.messages.find((item) => item.id === id);
      if (message && typeof action.text === "string") message.text = action.text;
    } else if (action.operation === "cancel" || action.operation === "take") {
      thread.queue.messages = thread.queue.messages.filter((item) => item.id !== id);
    } else if (action.operation === "steer") {
      const index = thread.queue.messages.findIndex((item) => item.id === id);
      const [message] = index < 0 ? [] : thread.queue.messages.splice(index, 1);
      if (message) {
        const turn = thread.turns.find((candidate) => candidate.id === action.turnId);
        turn?.items.push({
          id: `steered-${message.id}`,
          type: "userMessage",
          text: message.text,
          detail: "",
        });
      }
    }
  }
}

async function installRemoteApiFixture(page: Page): Promise<void> {
  const threads = new Map<string, FixtureThread>();
  const fulfill = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ data }) });

  await page.route("**/api/v1/remote/**", async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/v1/remote/models" && method === "GET") {
      return fulfill(route, [
        {
          id: "test-model",
          name: "Test model",
          efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          defaultEffort: "medium",
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
        {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          serviceTiers: [],
        },
        {
          id: "second-model",
          name: "Second model",
          efforts: ["low", "high"],
          defaultEffort: "low",
          serviceTiers: [],
        },
      ]);
    }
    if (pathname === "/api/v1/remote/usage" && method === "GET")
      return fulfill(route, { windows: [] });
    if (pathname === "/api/v1/remote/threads" && method === "GET") {
      const search = searchParams.get("search") ?? "";
      return fulfill(route, {
        threads: [...threads.values()]
          .filter((thread) => thread.title.includes(search))
          .map((thread) => ({
            id: thread.id,
            title: thread.title,
            preview: thread.turns.at(-1)?.items.at(-1)?.text ?? "",
            cwd: thread.cwd,
            updatedAt: Date.now() / 1000,
            status: thread.status,
          })),
        nextCursor: null,
      });
    }
    if (pathname === "/api/v1/remote/threads" && method === "POST") {
      const id = randomUUID();
      threads.set(id, createThread(id));
      return fulfill(route, { threadId: id }, 201);
    }

    const reviewMatch = pathname.match(/^\/api\/v1\/remote\/threads\/([0-9a-f-]+)\/review$/i);
    if (reviewMatch && method === "GET") {
      return fulfill(route, {
        repository: false,
        branch: null,
        baseRef: null,
        scope: searchParams.get("scope") ?? "branch",
        changedCount: 0,
        added: 0,
        removed: 0,
        countsComplete: true,
        files: [],
        message: "",
      });
    }

    const threadMatch = pathname.match(/^\/api\/v1\/remote\/threads\/([0-9a-f-]+)$/i);
    if (threadMatch) {
      let thread = threads.get(threadMatch[1]!);
      if (!thread) {
        thread = createThread(threadMatch[1]!);
        threads.set(thread.id, thread);
      }
      if (method === "GET") return fulfill(route, thread);
      if (method === "PATCH" || method === "POST") {
        const body = request.postDataJSON() as FixtureAction;
        applyAction(thread, body);
        return fulfill(route, {});
      }
    }

    const actionMatch = pathname.match(/^\/api\/v1\/remote\/threads\/([0-9a-f-]+)\/actions$/i);
    if (actionMatch && method === "POST") {
      let thread = threads.get(actionMatch[1]!);
      if (!thread) {
        thread = createThread(actionMatch[1]!);
        threads.set(thread.id, thread);
      }
      applyAction(thread, request.postDataJSON() as FixtureAction);
      return fulfill(route, {});
    }

    if (pathname === "/api/v1/remote/uploads" && method === "POST") {
      const upload = request.postDataJSON() as { name: string; mimeType: string; base64: string };
      return fulfill(route, {
        id: randomUUID(),
        name: upload.name,
        mimeType: upload.mimeType,
        size: Buffer.from(upload.base64, "base64").byteLength,
      });
    }
    if (pathname === "/api/v1/remote/uploads/chunks" && method === "POST") {
      const index = Number(searchParams.get("index"));
      const count = Number(searchParams.get("count"));
      if (index + 1 < count) return fulfill(route, null);
      return fulfill(route, {
        id: randomUUID(),
        name: searchParams.get("name") ?? "upload.bin",
        mimeType: searchParams.get("mimeType") ?? "application/octet-stream",
        size: Number(searchParams.get("size")) || 1,
      });
    }

    return route.continue();
  });
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await installRemoteApiFixture(page);
    await use(page);
  },
});

export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";
