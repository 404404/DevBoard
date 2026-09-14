import { seedProjectMember } from "./helpers/project-member-fixture.js";
import { identityKey } from "@lark-taskboard/contracts";
import { seedFeishuTestActor, TEST_FEISHU_IDENTITY } from "./helpers/identity.js";
import { EventPageSchema } from "@lark-taskboard/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { FakeThreadProvisioner } from "./fake-thread-provisioner.js";

const openApps: FastifyInstance[] = [];
const openDatabases: SqliteDatabase[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
});

function cookieHeader(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function developmentSetup(environment: Record<string, string> = {}) {
  const config = loadConfig({
    LARK_TASKBOARD_ENV: "test",
    LARK_TASKBOARD_WORKSPACE_ROOTS: process.cwd(),
    ...environment,
  });
  const database = initializeDatabase(":memory:");
  const app = createApp({
    config,
    database,
    codexThreadProvisioner: new FakeThreadProvisioner(),
  });
  openApps.push(app);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "EVENT",
    name: "事件 HTTP 项目",
    description: "",
  });
  database
    .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
    .run(process.cwd(), project.id);
  const trusted = { host: "127.0.0.1:47823", origin: "http://localhost:5173" };
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/development",
    headers: trusted,
  });
  seedFeishuTestActor(database);
  database.prepare("UPDATE sessions SET identity_key = ?").run(identityKey(TEST_FEISHU_IDENTITY));
  return {
    app,
    project,
    trusted,
    cookies: cookieHeader(login),
    csrfToken: login.json().data.csrfToken as string,
  };
}

async function createTask(
  app: FastifyInstance,
  projectId: string,
  trusted: { host: string; origin: string },
  cookies: string,
  csrfToken: string,
  idempotencyKey: string,
  title: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: {
      ...trusted,
      cookie: cookies,
      "x-csrf-token": csrfToken,
      "idempotency-key": idempotencyKey,
    },
    payload: { projectId, title },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { data: { id: string }; meta: { revision: number } };
}

async function readSseUntil(
  response: Awaited<ReturnType<FastifyInstance["inject"]>>,
  controller: AbortController,
  marker: string,
): Promise<string> {
  let body = "";
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    for await (const chunk of response.stream()) {
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (body.includes(marker)) {
        break;
      }
    }
  } catch (error: unknown) {
    if (!body.includes(marker)) {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return body;
}

describe("event feed HTTP and SSE routes", () => {
  it("requires authentication and returns contract-valid project event pages", async () => {
    const { app, project, trusted, cookies, csrfToken } = await developmentSetup();
    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/v1/events?projectId=${project.id}`,
      headers: { host: trusted.host },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const created = await createTask(
      app,
      project.id,
      trusted,
      cookies,
      csrfToken,
      "event-http-create-0001",
      "HTTP 事件",
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/events?projectId=${project.id}&afterRevision=0&limit=25`,
      headers: { host: trusted.host, cookie: cookies },
    });
    const page = EventPageSchema.parse(response.json().data);

    expect(response.statusCode).toBe(200);
    expect(page).toMatchObject({
      events: [
        {
          aggregateId: created.data.id,
          eventType: "task.created",
        },
        {
          revision: created.meta.revision,
          aggregateId: created.data.id,
          eventType: "codex.thread_created",
        },
      ],
      cursorRevision: created.meta.revision,
      hasMore: false,
      historyTruncated: false,
    });
  });

  it("streams authenticated SSE backlog from Last-Event-ID with safe buffering headers", async () => {
    const { app, project, trusted, cookies, csrfToken } = await developmentSetup();
    const first = await createTask(
      app,
      project.id,
      trusted,
      cookies,
      csrfToken,
      "event-sse-create-0001",
      "已接收事件",
    );
    const second = await createTask(
      app,
      project.id,
      trusted,
      cookies,
      csrfToken,
      "event-sse-create-0002",
      "待补偿事件",
    );
    const controller = new AbortController();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/events?projectId=${project.id}&afterRevision=0`,
      headers: {
        host: trusted.host,
        cookie: cookies,
        accept: "text/event-stream",
        "last-event-id": String(first.meta.revision),
      },
      payloadAsStream: true,
      signal: controller.signal,
    });
    const body = await readSseUntil(response, controller, `id: ${second.meta.revision}`);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(body).toContain("retry: 3000");
    expect(body).toContain(`id: ${second.meta.revision}`);
    expect(body).toContain("event: task.created");
    expect(body).toContain("待补偿事件");
    expect(body).not.toContain(`id: ${first.meta.revision}\n`);
  });

  it("keeps an idle authenticated SSE connection alive with heartbeat comments", async () => {
    const { app, project, trusted, cookies } = await developmentSetup({
      LARK_TASKBOARD_SSE_HEARTBEAT_MS: "1000",
    });
    const controller = new AbortController();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/events?projectId=${project.id}`,
      headers: {
        host: trusted.host,
        cookie: cookies,
        accept: "text/event-stream",
      },
      payloadAsStream: true,
      signal: controller.signal,
    });
    const body = await readSseUntil(response, controller, ": heartbeat ");

    expect(response.statusCode).toBe(200);
    expect(body).toContain("retry: 3000");
    expect(body).toContain(": heartbeat ");
  });

  it("allows verified users to subscribe without membership and rejects sessions without login evidence", async () => {
    const database = initializeDatabase(":memory:");
    openDatabases.push(database);
    const administration = new ProjectAdministration(database);
    const allowedProject = administration.createProject({
      projectKey: "ALLOW",
      name: "允许项目",
      description: "",
    });
    const otherProject = administration.createProject({
      projectKey: "OTHER",
      name: "其他项目",
      description: "",
    });
    seedProjectMember(database, allowedProject.id, {
      tenantKey: "tenant-feed-viewer",
      userId: "feed-viewer",
      name: "事件只读成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const config = loadConfig({
      LARK_TASKBOARD_ENV: "test",
      LARK_TASKBOARD_AUTH_MODE: "feishu",
      LARK_TASKBOARD_ORIGIN: "https://tasks.example.com",
      LARK_TASKBOARD_ALLOWED_HOSTS: "tasks.example.com",
      LARK_TASKBOARD_FEISHU_APP_ID: "cli_test",
      LARK_TASKBOARD_FEISHU_APP_SECRET: "secret-for-test",
    });
    const app = createApp({
      config,
      database,
      identityProvider: {
        kind: "feishu",
        async exchangeCode() {
          return {
            identity: { kind: "feishu", tenantKey: "tenant-feed-viewer", userId: "feed-viewer" },
            name: "事件只读成员",
            avatarUrl: null,
          };
        },
      },
      closeDatabaseOnClose: false,
    });
    openApps.push(app);
    const trusted = { host: "tasks.example.com", origin: "https://tasks.example.com" };
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: trusted,
      payload: { code: "feed-viewer-code" },
    });
    const url = `/api/v1/events?projectId=${otherProject.id}`;
    const unauthenticated = await app.inject({
      method: "GET",
      url,
      headers: { host: trusted.host, accept: "text/event-stream" },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const controller = new AbortController();
    const response = await app.inject({
      method: "GET",
      url,
      headers: {
        host: trusted.host,
        cookie: cookieHeader(login),
        accept: "text/event-stream",
      },
      payloadAsStream: true,
      signal: controller.signal,
    });
    const body = await readSseUntil(response, controller, "retry: 3000");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(body).toContain("retry: 3000");

    const unverifiedKey = '["feishu","tenant-feed-viewer","unverified"]';
    database
      .prepare(
        "INSERT INTO identities (identity_key,kind,tenant_key,user_id,name,role) VALUES (?, 'feishu', 'tenant-feed-viewer', 'unverified', '未验证账号', 'admin')",
      )
      .run(unverifiedKey);
    database.prepare("UPDATE sessions SET identity_key = ?").run(unverifiedKey);
    const rejected = await app.inject({
      method: "GET",
      url,
      headers: { host: trusted.host, cookie: cookieHeader(login), accept: "text/event-stream" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe("UNAUTHENTICATED");
  });
});
