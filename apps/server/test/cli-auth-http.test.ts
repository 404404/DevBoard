import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityKey, TEMPORARY_PROJECT_ID, type FeishuIdentityRef } from "@codexboard/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { appControl, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { createLocalAdminApp } from "../src/transports/local-admin-http.js";
import { FakeThreadProvisioner } from "./fake-thread-provisioner.js";

const resources: Array<{ apps: FastifyInstance[]; database: SqliteDatabase; root: string }> = [];
afterEach(async () => {
  for (const { apps, database, root } of resources.splice(0)) {
    for (const app of apps.reverse()) await app.close();
    if (database.open) database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
const user: FeishuIdentityRef = { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "taskctl-pairing-http-"));
  const database = initializeDatabase(":memory:");
  const config = loadConfig({
    CODEXBOARD_ENV: "test",
    CODEXBOARD_AUTH_MODE: "feishu",
    CODEXBOARD_ORIGIN: "https://tasks.example.com",
    CODEXBOARD_ALLOWED_HOSTS: "tasks.example.com",
    CODEXBOARD_FEISHU_APP_ID: "cli_test",
    CODEXBOARD_FEISHU_APP_SECRET: "test-secret",
    CODEXBOARD_DATA_DIR: root,
    CODEXBOARD_WORKSPACE_ROOTS: root,
    CODEXBOARD_TEMPORARY_PROJECT_ROOT: root,
  });
  database
    .prepare(
      `INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role, active) VALUES (?, 'feishu', ?, ?, 'Alice', 'admin', 1)`,
    )
    .run(identityKey(user), user.tenantKey, user.userId);
  const publicApp = createApp({
    config,
    database,
    closeDatabaseOnClose: false,
    codexThreadProvisioner: new FakeThreadProvisioner(),
    identityProvider: {
      kind: "feishu",
      exchangeCode: async () => ({ identity: user, name: "Alice", avatarUrl: null }),
    },
  });
  const apps = [publicApp];
  resources.push({ apps, database, root });
  const localHeaders = { host: "127.0.0.1:47824", authorization: `Bearer ${"x".repeat(43)}` };
  function localApp() {
    const app = createLocalAdminApp({
      config,
      database,
      capabilityToken: "x".repeat(43),
      services: appControl(publicApp).services,
    });
    apps.push(app);
    return app;
  }
  async function browserLogin() {
    const login = await publicApp.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: { host: "tasks.example.com", origin: config.CODEXBOARD_ORIGIN },
      payload: { code: "valid-feishu-code" },
    });
    expect(login.statusCode).toBe(201);
    return {
      host: "tasks.example.com",
      origin: config.CODEXBOARD_ORIGIN,
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-csrf-token": login.json().data.csrfToken as string,
    };
  }
  return { publicApp, localApp, localHeaders, database, browserLogin, root };
}

describe("CLI pairing HTTP boundary", () => {
  it("protects browser inspection before looking up the request", async () => {
    const test = setup();
    const response = await test.publicApp.inject({
      method: "GET",
      url: "/api/v1/auth/cli/requests/unknown",
      headers: { host: "tasks.example.com" },
    });
    expect(response.statusCode).toBe(401);
  });
  it("requires cookie + CSRF approval, rejects forged identity, claims once, and revokes independently", async () => {
    const test = setup();
    const local = test.localApp();
    const created = await local.inject({
      method: "POST",
      url: "/api/v1/local/auth/requests",
      headers: test.localHeaders,
      payload: { label: "My terminal" },
    });
    expect(created.statusCode).toBe(201);
    const { requestId, claimSecret, verificationCode, verificationUrl } = created.json().data;
    expect(new URL(verificationUrl).searchParams.get("taskctlLogin")).toBe(requestId);
    const browser = await test.browserLogin();
    const inspectUrl = `/api/v1/auth/cli/requests/${requestId}`;
    const inspected = await test.publicApp.inject({
      method: "GET",
      url: inspectUrl,
      headers: browser,
    });
    expect(inspected.json().data).toMatchObject({
      label: "My terminal",
      verificationCode,
      status: "pending",
    });
    expect(inspected.body).not.toContain(claimSecret);
    const noCsrf = { ...browser };
    delete (noCsrf as Partial<typeof noCsrf>)["x-csrf-token"];
    expect(
      (
        await test.publicApp.inject({
          method: "POST",
          url: `${inspectUrl}/approve`,
          headers: noCsrf,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await test.publicApp.inject({
          method: "POST",
          url: `${inspectUrl}/approve`,
          headers: browser,
          payload: { identity: { ...user, tenantKey: "forged" } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await test.publicApp.inject({
          method: "POST",
          url: `${inspectUrl}/approve`,
          headers: browser,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const claim = {
      method: "POST" as const,
      url: "/api/v1/local/auth/complete",
      headers: test.localHeaders,
      payload: { requestId, claimSecret },
    };
    const results = await Promise.all([local.inject(claim), local.inject(claim)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const token = results.find((r) => r.statusCode === 200)!.json().data.token;
    const sessionHeaders = { ...test.localHeaders, "x-taskctl-session": token };
    const session = await local.inject({
      method: "GET",
      url: "/api/v1/local/auth/session",
      headers: sessionHeaders,
    });
    expect(session.json().data.identity).toEqual(user);
    expect(session.body).not.toContain(token);
    expect(
      (
        await local.inject({
          method: "POST",
          url: "/api/v1/local/auth/logout",
          headers: sessionHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await local.inject({
          method: "GET",
          url: "/api/v1/local/projects",
          headers: sessionHeaders,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await test.publicApp.inject({ method: "GET", url: "/api/v1/session", headers: browser }))
        .statusCode,
    ).toBe(200);
  });
  it("revalidates active state without requiring an administrator role or falling back", async () => {
    const test = setup();
    const local = test.localApp();
    const browser = await test.browserLogin();
    const request = appControl(test.publicApp).services.cliAuth.create("test");
    appControl(test.publicApp).services.cliAuth.approve(request.requestId, user);
    const session = appControl(test.publicApp).services.cliAuth.complete(
      request.requestId,
      request.claimSecret,
    );
    if (!("token" in session)) throw new Error("missing session");
    const headers = { ...test.localHeaders, "x-taskctl-session": session.token };
    test.database
      .prepare("UPDATE identities SET role = 'member' WHERE identity_key = ?")
      .run(identityKey(user));
    expect(
      (await local.inject({ method: "POST", url: "/api/v1/local/backups", headers, payload: {} }))
        .statusCode,
    ).toBe(201);
    expect(
      (await local.inject({ method: "GET", url: "/api/v1/local/members/audit", headers }))
        .statusCode,
    ).toBe(200);
    test.database
      .prepare("UPDATE identities SET active = 0 WHERE identity_key = ?")
      .run(identityKey(user));
    for (const url of ["/api/v1/local/projects", "/api/v1/local/auth/session"])
      expect((await local.inject({ method: "GET", url, headers })).statusCode).toBe(401);
    expect(
      (
        await local.inject({
          method: "GET",
          url: "/api/v1/local/health",
          headers: test.localHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(browser.cookie).toBeTruthy();
  });
  it("allows the logged-in user to operate despite legacy viewer roles and forbids member creation", async () => {
    const test = setup();
    execFileSync("git", ["init", "-q", test.root]);
    execFileSync("git", [
      "-C",
      test.root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    const local = test.localApp();
    await test.browserLogin();
    const services = appControl(test.publicApp).services;
    services.projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "Viewer test",
          rootPaths: [test.root],
          position: 0,
        },
      ],
    });
    const project = test.database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .get("11111111-1111-4111-8111-111111111111") as { id: string };
    const request = services.cliAuth.create("viewer-test");
    services.cliAuth.approve(request.requestId, user);
    const session = services.cliAuth.complete(request.requestId, request.claimSecret);
    if (!("token" in session)) throw new Error("missing session");
    const headers = {
      ...test.localHeaders,
      "x-taskctl-session": session.token,
      "idempotency-key": "viewer-create",
    };
    const created = await local.inject({
      method: "POST",
      url: "/api/v1/local/tasks",
      headers,
      payload: { projectId: project.id, title: "Viewer permissions" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await local.inject({
      method: "POST",
      url: `/api/v1/local/tasks/${created.json().data.id}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "viewer-job" },
      payload: {},
    });
    expect(job.statusCode, job.body).toBe(202);
    test.database
      .prepare(
        "INSERT INTO project_members (project_id, identity_key, role) VALUES (?, ?, 'viewer')",
      )
      .run(project.id, identityKey(user));
    test.database
      .prepare("UPDATE identities SET role = 'member' WHERE identity_key = ?")
      .run(identityKey(user));
    const canceled = await local.inject({
      method: "POST",
      url: `/api/v1/local/jobs/${job.json().data.id}/cancel`,
      headers: { ...headers, "idempotency-key": "viewer-cancel" },
      payload: {},
    });
    expect(canceled.statusCode, canceled.body).toBe(202);
    expect(canceled.json().data.target.status).toBe("canceled");
    expect(
      (
        await local.inject({
          method: "GET",
          url: `/api/v1/local/projects/${project.id}/git`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const bootstrap = await local.inject({
      method: "PUT",
      url: `/api/v1/local/projects/${project.id}/members/bootstrap`,
      headers,
      payload: {
        tenantKey: user.tenantKey,
        userId: user.userId,
        name: "Alice",
        projectRole: "owner",
        actorRole: "admin",
      },
    });
    expect(bootstrap.statusCode).toBe(404);
    expect(
      test.database
        .prepare("SELECT role FROM identities WHERE identity_key = ?")
        .pluck()
        .get(identityKey(user)),
    ).toBe("member");
    expect(
      (
        await local.inject({
          method: "POST",
          url: `/api/v1/local/projects/${project.id}/contexts/scan`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("requires a real user for task creation and assigns themself without accepting another tenant", async () => {
    const test = setup();
    const local = test.localApp();
    const command = { projectId: TEMPORARY_PROJECT_ID, title: "Paired task" };
    expect(
      (
        await local.inject({
          method: "POST",
          url: "/api/v1/local/tasks",
          headers: { ...test.localHeaders, "idempotency-key": "service-create" },
          payload: command,
        })
      ).statusCode,
    ).toBe(401);
    await test.browserLogin();
    const request = appControl(test.publicApp).services.cliAuth.create("test");
    appControl(test.publicApp).services.cliAuth.approve(request.requestId, user);
    const session = appControl(test.publicApp).services.cliAuth.complete(
      request.requestId,
      request.claimSecret,
    );
    if (!("token" in session)) throw new Error("missing session");
    const headers = {
      ...test.localHeaders,
      "x-taskctl-session": session.token,
      "idempotency-key": "user-create",
    };
    const created = await local.inject({
      method: "POST",
      url: "/api/v1/local/tasks",
      headers,
      payload: command,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.assigneeIdentity).toEqual(user);
    expect(created.json().data.creatorIdentity).toEqual(user);
    expect(
      (
        await local.inject({
          method: "POST",
          url: "/api/v1/local/tasks",
          headers: { ...headers, "idempotency-key": "other-create" },
          payload: { ...command, assigneeIdentity: { ...user, tenantKey: "another-tenant" } },
        })
      ).statusCode,
    ).toBe(403);
  });
});
