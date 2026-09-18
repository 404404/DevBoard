import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateTaskCommandSchema, identityKey, TEMPORARY_PROJECT_ID } from "@codexboard/contracts";
import { afterEach, expect, it } from "vitest";
import { appControl, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { WebAccountService } from "../src/modules/identity/web-account-service.js";
import { createLocalAdminApp } from "../src/transports/local-admin-http.js";
import { FakeThreadProvisioner } from "./fake-thread-provisioner.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const password = "A-long-private-password-2026";
function setup(protocol = "https", mode: "feishu" | "web" = "feishu") {
  const root = mkdtempSync(join(tmpdir(), "web-account-test-"));
  const database = initializeDatabase(":memory:");
  const config = loadConfig({
    CODEXBOARD_ENV: "test",
    CODEXBOARD_AUTH_MODE: mode,
    CODEXBOARD_ORIGIN: `${protocol}://tasks.example.com`,
    CODEXBOARD_ALLOWED_HOSTS: "tasks.example.com",
    CODEXBOARD_FEISHU_APP_ID: mode === "feishu" ? "cli_test" : undefined,
    CODEXBOARD_FEISHU_APP_SECRET: mode === "feishu" ? "test-secret" : undefined,
    CODEXBOARD_DATA_DIR: root,
    CODEXBOARD_WORKSPACE_ROOTS: root,
    CODEXBOARD_TEMPORARY_PROJECT_ROOT: root,
  });
  const app = createApp({
    config,
    database,
    closeDatabaseOnClose: false,
    codexThreadProvisioner: new FakeThreadProvisioner(),
    ...(mode === "feishu"
      ? {
          identityProvider: {
            kind: "feishu",
            exchangeCode: async () => {
              throw new Error("Web login must not call Feishu");
            },
          },
        }
      : {}),
  });
  const local = createLocalAdminApp({
    config,
    database,
    capabilityToken: "x".repeat(43),
    services: appControl(app).services,
  });
  cleanups.push(async () => {
    await local.close();
    await app.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const headers = { host: "tasks.example.com", origin: config.CODEXBOARD_ORIGIN };
  const localHeaders = { host: "127.0.0.1:47824", authorization: `Bearer ${"x".repeat(43)}` };
  const accounts = new WebAccountService(database);
  const login = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/web/login",
      headers,
      payload: { username: "alice", password },
    });
  return { root, database, app, local, headers, localHeaders, accounts, login };
}
it.each(["feishu", "web"] as const)(
  "%s: only local management can provision accounts; public login owns tasks and comments",
  async (mode) => {
    const t = setup("https", mode);
    expect((await t.login()).statusCode).toBe(403);
    expect((await t.app.inject({ url: "/api/v1/projects", headers: t.headers })).statusCode).toBe(
      401,
    );
    const payload = { username: "Alice", name: "Alice Web", password };
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/local/web-accounts",
          headers: t.headers,
          payload,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.local.inject({
          method: "POST",
          url: "/api/v1/local/web-accounts",
          headers: { host: t.localHeaders.host },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await t.local.inject({
          method: "POST",
          url: "/api/v1/local/web-accounts",
          headers: { ...t.localHeaders, origin: "https://evil.example" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const created = await t.local.inject({
      method: "POST",
      url: "/api/v1/local/web-accounts",
      headers: t.localHeaders,
      payload,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain(password);
    const id = created.json().data.id;
    const stored = t.database
      .prepare("SELECT password_hash FROM web_accounts WHERE id = ?")
      .get(id) as { password_hash: string };
    expect(stored.password_hash).toMatch(/^scrypt-v1\$/);
    expect(stored.password_hash).not.toContain(password);
    const response = await t.login();
    expect(response.statusCode, response.body).toBe(201);
    const identity = { kind: "web", accountId: id };
    expect(response.json().data.actor.identity).toEqual(identity);
    expect(response.cookies.find((cookie) => cookie.name.endsWith("session"))).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    const headers = {
      ...t.headers,
      cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-csrf-token": response.json().data.csrfToken,
    };
    const options = await t.app.inject({
      url: `/api/v1/projects/${TEMPORARY_PROJECT_ID}/task-creation-options`,
      headers,
    });
    // Direct domain calls exercise the same shared task permissions while avoiding a real Codex bridge.
    const viaHttp = await t.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...headers, "idempotency-key": "web-http-create" },
      payload: { projectId: TEMPORARY_PROJECT_ID, title: "Created from browser" },
    });
    expect(viaHttp.statusCode, viaHttp.body).toBe(201);
    expect(viaHttp.json().data.assigneeIdentity).toEqual(identity);
    const actor = response.json().data.actor;
    const context = { actor, requestId: "web-create", idempotencyKey: "web-create-unique-key" };
    const services = appControl(t.app).services;
    const candidates = services.taskboard.readTaskCreationOptions(
      TEMPORARY_PROJECT_ID,
      actor,
      () => [],
    );
    expect(candidates.assignees[0]?.identity).toEqual(identity);
    const task = services.taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: TEMPORARY_PROJECT_ID, title: "Web task" }),
      context,
    );
    expect(task.task.assigneeIdentity).toEqual(identity);
    const comment = services.workspace.createComment(
      task.task.id,
      { body: "Web comment" },
      context,
    );
    expect(comment.data.author?.identity).toEqual(identity);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/session/logout",
          headers: { ...headers, "x-csrf-token": "wrong" },
        })
      ).statusCode,
    ).toBe(403);
    const reset = await t.local.inject({
      method: "PATCH",
      url: `/api/v1/local/web-accounts/${id}`,
      headers: t.localHeaders,
      payload: { password: "Another-long-private-password" },
    });
    expect(reset.statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/v1/session", headers })).statusCode).toBe(401);
    expect((await t.login()).statusCode).toBe(401);
    expect(t.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(identityKey(actor.identity)).toContain("web");
    expect(options.statusCode).toBe(200);
  },
);
it("blocks HTTP password login, cross-origin and forged Host requests", async () => {
  const t = setup("http");
  await t.accounts.create({ username: "alice", name: "Alice", password });
  expect((await t.login()).statusCode).toBe(403);
  expect(
    (
      await t.app.inject({
        method: "POST",
        url: "/api/v1/auth/web/login",
        headers: { ...t.headers, origin: "https://evil.example" },
        payload: { username: "alice", password },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await t.app.inject({
        method: "POST",
        url: "/api/v1/auth/web/login",
        headers: { ...t.headers, host: "evil.example" },
        payload: { username: "alice", password },
      })
    ).statusCode,
  ).toBe(400);
});
it("locks after five guesses across service instances and disables existing sessions", async () => {
  const t = setup();
  const account = await t.accounts.create({ username: "alice", name: "Alice", password });
  const login = await t.login();
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  for (let n = 0; n < 5; n++)
    await expect(t.accounts.verify({ username: "alice", password: "wrong" })).rejects.toThrow();
  await expect(
    new WebAccountService(t.database).verify({ username: "alice", password }),
  ).rejects.toThrow();
  await t.accounts.update(account.id, { active: false });
  expect(
    (await t.app.inject({ url: "/api/v1/session", headers: { ...t.headers, cookie } })).statusCode,
  ).toBe(401);
  await expect(t.accounts.verify({ username: "alice", password })).rejects.toThrow();
});

it("bounds simultaneous password verification and unlocks after the persisted lock expires", async () => {
  const t = setup();
  let now = Date.now();
  const service = new WebAccountService(t.database, () => now);
  await service.create({ username: "alice", name: "Alice", password });
  const attempts = await Promise.allSettled([
    service.verify({ username: "alice", password: "wrong" }),
    service.verify({ username: "alice", password: "wrong" }),
    service.verify({ username: "alice", password: "wrong" }),
  ]);
  expect(attempts[2]).toMatchObject({ status: "rejected", reason: { statusCode: 429 } });
  for (let n = 0; n < 3; n++)
    await expect(service.verify({ username: "alice", password: "wrong" })).rejects.toThrow();
  await expect(service.verify({ username: "alice", password })).rejects.toThrow();
  now += 15 * 60_000 + 1;
  await expect(service.verify({ username: "alice", password })).resolves.toBeTypeOf("string");
});

it("accepts eight-character passwords for creation and reset and rejects shorter ones", async () => {
  const t = setup();
  await expect(
    t.accounts.create({ username: "alice", name: "Alice", password: "1234567" }),
  ).rejects.toThrow();
  const account = await t.accounts.create({
    username: "alice",
    name: "Alice",
    password: "abcdefgh",
  });
  await expect(t.accounts.verify({ username: "alice", password: "abcdefgh" })).resolves.toBe(
    account.id,
  );
  await expect(t.accounts.update(account.id, { password: "1234567" })).rejects.toThrow();
  await t.accounts.update(account.id, { password: "87654321" });
  await expect(t.accounts.verify({ username: "alice", password: "87654321" })).resolves.toBe(
    account.id,
  );
});

it("Web-only mode has no development or Feishu login and advertises account login", async () => {
  const t = setup("https", "web");
  const response = await t.app.inject({ url: "/api/v1/auth/config", headers: t.headers });
  expect(response.json().data).toEqual({
    authMode: "web",
    feishuAppId: null,
    webLoginEnabled: false,
  });
  for (const url of ["/api/v1/auth/development", "/api/v1/auth/feishu/exchange"]) {
    expect(
      (
        await t.app.inject({
          method: "POST",
          url,
          headers: t.headers,
          payload: { code: "test-code" },
        })
      ).statusCode,
    ).toBe(404);
  }
  expect(() =>
    loadConfig({ CODEXBOARD_AUTH_MODE: "web", CODEXBOARD_ORIGIN: "http://tasks.example.com" }),
  ).toThrow();
});

it.each(["feishu", "web"] as const)(
  "%s: a paired Web CLI uses the approving user for tasks and comments and cannot impersonate another user",
  async (mode) => {
    const t = setup("https", mode);
    const alice = await t.accounts.create({ username: "alice", name: "Alice Web", password });
    const bob = await t.accounts.create({ username: "bob", name: "Bob Web", password });
    const identity = { kind: "web", accountId: alice.id };
    const login = await t.login();
    const browser = {
      ...t.headers,
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-csrf-token": login.json().data.csrfToken,
    };
    const created = await t.local.inject({
      method: "POST",
      url: "/api/v1/local/auth/requests",
      headers: t.localHeaders,
      payload: { label: "Web terminal" },
    });
    expect(created.statusCode).toBe(201);
    const { requestId, claimSecret } = created.json().data;
    const url = `/api/v1/auth/cli/requests/${requestId}`;
    const inspected = await t.app.inject({ url, headers: browser });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().data.status).toBe("pending");
    expect(inspected.body).not.toContain(claimSecret);
    for (const identity of [
      { kind: "web", accountId: bob.id },
      { kind: "service", serviceId: "local-admin" },
    ]) {
      expect(
        (
          await t.app.inject({
            method: "POST",
            url: `${url}/approve`,
            headers: browser,
            payload: { identity },
          })
        ).statusCode,
      ).toBe(400);
    }
    const missingCsrf = { ...browser, "x-csrf-token": "wrong" };
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `${url}/approve`,
          headers: missingCsrf,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ method: "POST", url: `${url}/approve`, headers: browser, payload: {} }))
        .statusCode,
    ).toBe(200);
    const bobLogin = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/web/login",
      headers: t.headers,
      payload: { username: "bob", password },
    });
    const bobBrowser = {
      ...t.headers,
      cookie: bobLogin.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-csrf-token": bobLogin.json().data.csrfToken,
    };
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `${url}/approve`,
          headers: bobBrowser,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    const complete = await t.local.inject({
      method: "POST",
      url: "/api/v1/local/auth/complete",
      headers: t.localHeaders,
      payload: { requestId, claimSecret },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json().data.identity).toEqual(identity);
    const token = complete.json().data.token;
    const headers = { ...t.localHeaders, "x-taskctl-session": token };
    const status = await t.local.inject({ url: "/api/v1/local/auth/session", headers });
    expect(status.json().data.identity).toEqual(identity);
    expect(status.body).not.toContain(token);
    const task = await t.local.inject({
      method: "POST",
      url: "/api/v1/local/tasks",
      headers: { ...headers, "idempotency-key": "web-cli-create" },
      payload: { projectId: TEMPORARY_PROJECT_ID, title: "Web CLI task" },
    });
    expect(task.statusCode, task.body).toBe(201);
    expect(task.json().data).toMatchObject({
      assigneeIdentity: identity,
      creatorIdentity: identity,
    });
    const comment = await t.local.inject({
      method: "POST",
      url: `/api/v1/local/tasks/${task.json().data.id}/comments`,
      headers: { ...headers, "idempotency-key": "web-cli-comment" },
      payload: { body: "Web CLI comment" },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    expect(comment.json().data.author.identity).toEqual(identity);
    expect(
      (
        await t.local.inject({
          method: "POST",
          url: `/api/v1/local/tasks/${task.json().data.id}/comments`,
          headers: { ...headers, "idempotency-key": "web-cli-forged-comment" },
          payload: { body: "Forged comment", authorIdentity: { kind: "web", accountId: bob.id } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await t.local.inject({
          method: "POST",
          url: "/api/v1/local/tasks",
          headers: { ...headers, "idempotency-key": "web-cli-forged-create" },
          payload: {
            projectId: TEMPORARY_PROJECT_ID,
            title: "Forged task",
            assigneeIdentity: { kind: "web", accountId: bob.id },
          },
        })
      ).statusCode,
    ).toBe(403);
    // Browser logout and CLI logout are independent; only account changes revoke both.
    expect(
      (await t.app.inject({ method: "POST", url: "/api/v1/session/logout", headers: browser }))
        .statusCode,
    ).toBe(204);
    expect((await t.local.inject({ url: "/api/v1/local/projects", headers })).statusCode).toBe(200);
  },
);

it.each(["reset", "disable"] as const)(
  "%s revokes Web CLI sessions and approved unclaimed requests across account service instances",
  async (change) => {
    const t = setup("https", "web");
    const account = await t.accounts.create({ username: "alice", name: "Alice", password });
    await t.login();
    const services = appControl(t.app).services;
    const identity = { kind: "web" as const, accountId: account.id };
    const approved = services.cliAuth.create("approved");
    const claimed = services.cliAuth.create("claimed");
    const dormant = services.cliAuth.create("unused while disabled");
    services.cliAuth.approve(approved.requestId, identity);
    services.cliAuth.approve(claimed.requestId, identity);
    services.cliAuth.approve(dormant.requestId, identity);
    const session = services.cliAuth.complete(claimed.requestId, claimed.claimSecret);
    const dormantSession = services.cliAuth.complete(dormant.requestId, dormant.claimSecret);
    if (!("token" in session)) throw new Error("Missing CLI session");
    if (!("token" in dormantSession)) throw new Error("Missing dormant CLI session");
    const headers = { ...t.localHeaders, "x-taskctl-session": session.token };
    expect((await t.local.inject({ url: "/api/v1/local/projects", headers })).statusCode).toBe(200);
    // Use another instance to ensure invalidation relies on durable state, not callbacks.
    const accountManager = new WebAccountService(t.database);
    await accountManager.update(
      account.id,
      change === "reset" ? { password: "reset-password-2026" } : { active: false },
    );
    for (const url of ["/api/v1/local/auth/session", "/api/v1/local/projects"]) {
      expect((await t.local.inject({ url, headers })).statusCode).toBe(401);
    }
    if (change === "disable") await accountManager.update(account.id, { active: true });
    // Re-enabling the account must not revive either a session or a pending claim.
    expect((await t.local.inject({ url: "/api/v1/local/projects", headers })).statusCode).toBe(401);
    expect(
      (
        await t.local.inject({
          url: "/api/v1/local/projects",
          headers: { ...t.localHeaders, "x-taskctl-session": dormantSession.token },
        })
      ).statusCode,
    ).toBe(401);
    const complete = await t.local.inject({
      method: "POST",
      url: "/api/v1/local/auth/complete",
      headers: t.localHeaders,
      payload: { requestId: approved.requestId, claimSecret: approved.claimSecret },
    });
    expect(complete.statusCode).toBe(401);
    expect(complete.json().error.details.reason).toBe("CLI_AUTH_SESSION_INVALID");
    const renewed = services.cliAuth.create("renewed");
    services.cliAuth.approve(renewed.requestId, identity);
    const freshSession = services.cliAuth.complete(renewed.requestId, renewed.claimSecret);
    if (!("token" in freshSession)) throw new Error("Missing fresh CLI session");
    expect(
      (
        await t.local.inject({
          url: "/api/v1/local/projects",
          headers: { ...t.localHeaders, "x-taskctl-session": freshSession.token },
        })
      ).statusCode,
    ).toBe(200);
  },
);
