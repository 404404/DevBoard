import { seedProjectMember } from "./helpers/project-member-fixture.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identityKey, type IdentityRef, TEMPORARY_PROJECT_ID } from "@codexboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { appControl, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { createLocalAdminApp } from "../src/transports/local-admin-http.js";
import { FakeThreadProvisioner } from "./fake-thread-provisioner.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "taskboard-identity-policy-"));
  const database = initializeDatabase(":memory:");
  const config = loadConfig({
    CODEXBOARD_ENV: "test",
    CODEXBOARD_AUTH_MODE: "feishu",
    CODEXBOARD_ORIGIN: "https://tasks.example.com",
    CODEXBOARD_ALLOWED_HOSTS: "tasks.example.com",
    CODEXBOARD_FEISHU_APP_ID: "cli_test",
    CODEXBOARD_FEISHU_APP_SECRET: "test-secret",
    CODEXBOARD_DATA_DIR: directory,
    CODEXBOARD_WORKSPACE_ROOTS: directory,
  });
  const member = (userId: string, name: string) =>
    seedProjectMember(database, TEMPORARY_PROJECT_ID, {
      tenantKey: "policy-tenant",
      userId,
      name,
      avatarUrl: null,
      actorRole: "member",
      projectRole: "editor",
    });
  const alice = member("ou_alice", "Alice");
  const bob = member("ou_bob", "Bob");
  const unverified = member("ou_unverified", "看似真实但未登录");
  const publicApp = createApp({
    config,
    database,
    closeDatabaseOnClose: false,
    codexThreadProvisioner: new FakeThreadProvisioner(),
    identityProvider: {
      kind: "feishu",
      async exchangeCode(code) {
        return {
          identity: {
            kind: "feishu",
            tenantKey: "policy-tenant",
            userId: code === "alice-auth-code" ? "ou_alice" : "ou_bob",
          },
          name: code === "alice-auth-code" ? "Alice" : "Bob",
          avatarUrl: null,
        };
      },
    },
  });
  const capabilityToken = "x".repeat(43);
  const localApp = createLocalAdminApp({
    config,
    database,
    capabilityToken,
    services: appControl(publicApp).services,
  });
  cleanups.push(async () => {
    await localApp.close();
    await publicApp.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const localHeaders = {
    host: "127.0.0.1:47824",
    authorization: `Bearer ${capabilityToken}`,
    "idempotency-key": "local-policy-request",
  };
  async function login(code: string) {
    const response = await publicApp.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: { host: "tasks.example.com", origin: "https://tasks.example.com" },
      payload: { code },
    });
    expect(response.statusCode).toBe(201);
    return {
      host: "tasks.example.com",
      origin: "https://tasks.example.com",
      cookie: response.cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
      "x-csrf-token": String(response.json().data.csrfToken),
      "idempotency-key": `policy-${code}`,
    };
  }
  async function loginCli(code: string) {
    await login(code);
    const cliAuth = appControl(publicApp).services.cliAuth;
    const request = cliAuth.create("identity-policy-test");
    cliAuth.approve(request.requestId, code === "alice-auth-code" ? alice.identity : bob.identity);
    const session = cliAuth.complete(request.requestId, request.claimSecret);
    if (!("token" in session)) throw new Error("missing CLI session");
    return { ...localHeaders, "x-taskctl-session": session.token };
  }
  return {
    database,
    publicApp,
    localApp,
    localHeaders,
    login,
    loginCli,
    alice,
    bob,
    unverified,
    member,
  };
}

describe("Feishu owner and comment identity policy", () => {
  it("offers only login-verified Feishu users and binds new tasks to the current Feishu session", async () => {
    const { publicApp, login, alice, bob } = setup();
    const headers = await login("alice-auth-code");
    await login("bob-auth-code");
    const options = await publicApp.inject({
      method: "GET",
      url: `/api/v1/projects/${TEMPORARY_PROJECT_ID}/task-creation-options`,
      headers,
    });
    expect(
      options.json().data.assignees.map((entry: { identity: IdentityRef }) => entry.identity),
    ).toEqual([alice.identity]);
    const created = await publicApp.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { projectId: TEMPORARY_PROJECT_ID, title: "会话归属" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.assigneeIdentity).toEqual(alice.identity);
    const comment = await publicApp.inject({
      method: "POST",
      url: `/api/v1/tasks/${created.json().data.id}/comments`,
      headers: { ...headers, "idempotency-key": "human-comment" },
      payload: { body: "用户评论", authorId: bob.identity, source: "codex" },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    expect(comment.json().data).toMatchObject({
      source: "user",
      author: { identity: alice.identity },
    });
  });

  it("rejects local comment writes even with a capability token or a forged Codex author", async () => {
    const { publicApp, localApp, localHeaders, login, database, alice } = setup();
    const headers = await login("alice-auth-code");
    const created = await publicApp.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { projectId: TEMPORARY_PROJECT_ID, title: "评论来源" },
    });
    const taskId = created.json().data.id as string;
    const human = await publicApp.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/comments`,
      headers: { ...headers, "idempotency-key": "genuine-comment" },
      payload: { body: "飞书用户原文" },
    });
    const commentId = human.json().data.id as string;
    for (const [method, url, payload] of [
      [
        "POST",
        `/api/v1/local/tasks/${taskId}/comments`,
        { body: "重复进度", source: "codex", authorId: alice.identity },
      ],
      ["PATCH", `/api/v1/local/comments/${commentId}`, { body: "篡改评论", expectedVersion: 1 }],
      ["DELETE", `/api/v1/local/comments/${commentId}`, { expectedVersion: 1 }],
    ] as const) {
      const response = await localApp.inject({ method, url, headers: localHeaders, payload });
      expect(response.statusCode, response.body).toBe(401);
    }
    expect(
      database.prepare("SELECT body FROM comments WHERE deleted_at IS NULL").pluck().all(),
    ).toEqual(["飞书用户原文"]);
  });

  it("audits verified and unverified identities as the paired user without creating a local service identity", async () => {
    const { localApp, localHeaders, loginCli, alice, unverified } = setup();
    const userHeaders = await loginCli("alice-auth-code");
    const url = "/api/v1/local/members/audit";
    expect((await localApp.inject({ method: "GET", url })).statusCode).toBe(403);
    expect((await localApp.inject({ method: "GET", url, headers: localHeaders })).statusCode).toBe(
      401,
    );
    const response = await localApp.inject({ method: "GET", url, headers: userHeaders });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: alice.identity,
          identityKind: "feishu",
          eligibleAssignee: true,
        }),
        expect.objectContaining({
          identity: unverified.identity,
          identityKind: "unverified",
          eligibleAssignee: false,
        }),
      ]),
    );
    expect(response.json().data.summary.localService).toBe(0);
    expect(response.body).not.toContain("capabilityToken");
  });

  it("requires a fresh Feishu login for historical sessions and validates reassignment", async () => {
    const { publicApp, login, database, alice, bob, unverified, localApp, localHeaders } = setup();
    const historicalToken = "historical-session-token";
    database
      .prepare(
        "INSERT INTO sessions (id_hash, identity_key, csrf_hash, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        createHash("sha256").update(historicalToken).digest("hex"),
        identityKey(alice.identity),
        "historical-csrf",
        "2099-01-01T00:00:00.000Z",
      );
    expect(
      (
        await publicApp.inject({
          method: "GET",
          url: "/api/v1/session",
          headers: {
            host: "tasks.example.com",
            cookie: `__Host-codexboard_session=${historicalToken}`,
          },
        })
      ).statusCode,
    ).toBe(401);
    const fresh = await login("alice-auth-code");
    await login("bob-auth-code");
    const created = await publicApp.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: fresh,
      payload: { projectId: TEMPORARY_PROJECT_ID, title: "负责人验证", assigneeIdentity: null },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.assigneeIdentity).toEqual(alice.identity);
    const task = created.json().data;
    for (const [assigneeIdentity, status] of [
      [unverified.identity, 403],
      [bob.identity, 403],
      [null, 403],
      ["00000000-0000-4000-8000-000000000001", 400],
    ] as const) {
      expect(
        (
          await publicApp.inject({
            method: "PATCH",
            url: `/api/v1/tasks/${task.id}`,
            headers: { ...fresh, "idempotency-key": `reject-${assigneeIdentity}` },
            payload: { expectedVersion: task.version, assigneeIdentity },
          })
        ).statusCode,
      ).toBe(status);
    }
    const reassigned = await publicApp.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${task.id}`,
      headers: { ...fresh, "idempotency-key": "valid-owner" },
      payload: { expectedVersion: task.version, assigneeIdentity: alice.identity },
    });
    expect(reassigned.statusCode, reassigned.body).toBe(200);
    expect(reassigned.json().data.assigneeIdentity).toEqual(alice.identity);
    const localCreated = await localApp.inject({
      method: "POST",
      url: "/api/v1/local/tasks",
      headers: localHeaders,
      payload: {
        projectId: TEMPORARY_PROJECT_ID,
        title: "有明确负责人",
        assigneeIdentity: alice.identity,
      },
    });
    expect(localCreated.statusCode, localCreated.body).toBe(401);
    database
      .prepare("UPDATE identities SET active = 0 WHERE identity_key = ?")
      .run(identityKey(bob.identity));
    expect(
      (
        await localApp.inject({
          method: "POST",
          url: "/api/v1/local/tasks",
          headers: { ...localHeaders, "idempotency-key": "inactive-owner" },
          payload: {
            projectId: TEMPORARY_PROJECT_ID,
            title: "失效负责人",
            assigneeIdentity: bob.identity,
          },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("rejects unverified owners on the local creation path and keeps verified profile names", async () => {
    const { localApp, localHeaders, login, alice, unverified, database } = setup();
    await login("alice-auth-code");
    expect(
      database
        .prepare("SELECT name FROM identities WHERE identity_key = ?")
        .pluck()
        .get(identityKey(alice.identity)),
    ).toBe("Alice");
    for (const assigneeIdentity of [null, unverified.identity]) {
      const response = await localApp.inject({
        method: "POST",
        url: "/api/v1/local/tasks",
        headers: localHeaders,
        payload: { projectId: TEMPORARY_PROJECT_ID, title: "本机任务", assigneeIdentity },
      });
      expect(response.statusCode, response.body).toBe(401);
    }
  });
});
