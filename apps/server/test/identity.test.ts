import {
  AuthBootstrapSchema,
  SessionViewSchema,
  identityKey,
  type FeishuIdentityRef,
} from "@lark-codex/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AppError } from "../src/app-error.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  FeishuIdentityAdapter,
  IdentityService,
  type IdentityProvider,
} from "../src/modules/identity/index.js";

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

function developmentApp(): FastifyInstance {
  const app = createApp({
    config: loadConfig({ LARK_CODEX_ENV: "test" }),
    database: initializeDatabase(":memory:"),
  });
  openApps.push(app);
  return app;
}

function cookieHeader(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

describe("identity HTTP boundary", () => {
  it("requires a session before issuing Feishu JSAPI signatures", async () => {
    const app = developmentApp();
    const result = await app.inject({
      method: "GET",
      url: "/api/v1/auth/feishu/jsapi-config?url=https%3A%2F%2Ftasks.example.test",
      headers: { host: "127.0.0.1:47823" },
    });
    expect(result.statusCode).toBe(401);
  });
  it("creates, reads and revokes a localhost development session", async () => {
    const app = developmentApp();
    const trustedHeaders = {
      host: "127.0.0.1:47823",
      origin: "http://localhost:5173",
    };
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/auth/config",
      headers: { host: trustedHeaders.host },
    });

    expect(AuthBootstrapSchema.parse(bootstrap.json().data)).toEqual({
      authMode: "development",
      feishuAppId: null,
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/development",
      headers: trustedHeaders,
    });
    const loginPayload: unknown = login.json().data;
    const sessionView = SessionViewSchema.parse(loginPayload);
    const cookies = cookieHeader(login);

    expect(login.statusCode).toBe(201);
    expect(sessionView.actor.role).toBe("admin");
    expect(login.cookies.find((cookie) => cookie.name === "lark_codex_session")?.httpOnly).toBe(
      true,
    );

    const session = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: trustedHeaders.host, cookie: cookies },
    });
    expect(session.statusCode).toBe(200);
    expect(SessionViewSchema.parse(session.json().data).actor.identity).toEqual(
      sessionView.actor.identity,
    );

    const rejectedLogout = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: { ...trustedHeaders, cookie: cookies },
    });
    expect(rejectedLogout.statusCode).toBe(403);
    expect(rejectedLogout.json().error.code).toBe("CSRF_INVALID");

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: {
        ...trustedHeaders,
        cookie: cookies,
        "x-csrf-token": sessionView.csrfToken,
      },
    });
    expect(logout.statusCode).toBe(204);

    const expiredSession = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: trustedHeaders.host, cookie: cookies },
    });
    expect(expiredSession.statusCode).toBe(401);
  });

  it("rejects untrusted hosts, origins and origin-less writes", async () => {
    const app = developmentApp();

    const wrongHost = await app.inject({
      method: "POST",
      url: "/api/v1/auth/development",
      headers: { host: "evil.example", origin: "http://localhost:5173" },
    });
    expect(wrongHost.statusCode).toBe(400);

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/development",
      headers: { host: "127.0.0.1:47823", origin: "https://evil.example" },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/development",
      headers: { host: "127.0.0.1:47823" },
    });
    expect(missingOrigin.statusCode).toBe(403);
  });

  it("allows a newly verified Feishu identity without prior registration", async () => {
    const provider: IdentityProvider = {
      kind: "feishu",
      async exchangeCode() {
        return {
          identity: { kind: "feishu", tenantKey: "tenant-1", userId: "new-user" },
          name: "飞书成员",
          avatarUrl: null,
        };
      },
    };
    const database = initializeDatabase(":memory:");
    const app = createApp({
      config: loadConfig({
        LARK_CODEX_ENV: "test",
        LARK_CODEX_AUTH_MODE: "feishu",
        LARK_CODEX_ORIGIN: "https://tasks.example.com",
        LARK_CODEX_ALLOWED_HOSTS: "tasks.example.com",
        LARK_CODEX_FEISHU_APP_ID: "cli_test",
        LARK_CODEX_FEISHU_APP_SECRET: "secret-for-test",
      }),
      database,
      identityProvider: provider,
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: { host: "tasks.example.com", origin: "https://tasks.example.com" },
      payload: { code: "authorization-code" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.actor).toMatchObject({
      identity: { kind: "feishu", tenantKey: "tenant-1", userId: "new-user" },
      name: "飞书成员",
      role: "member",
    });
    expect(
      database
        .prepare("SELECT kind, tenant_key, user_id, active FROM identities WHERE kind = 'feishu'")
        .all(),
    ).toEqual([{ kind: "feishu", tenant_key: "tenant-1", user_id: "new-user", active: 1 }]);
    const session = await app.inject({
      url: "/api/v1/session",
      headers: { host: "tasks.example.com", cookie: cookieHeader(response) },
    });
    expect(session.statusCode).toBe(200);
  });

  it.each([
    {
      origin: "https://tasks.example.com",
      host: "tasks.example.com",
      sessionName: "__Host-lark_codex_session",
      csrfName: "__Host-lark_codex_csrf",
      secure: true,
    },
    {
      origin: "http://1.1.1.1:47823",
      host: "1.1.1.1:47823",
      sessionName: "lark_codex_session",
      csrfName: "lark_codex_csrf",
      secure: false,
    },
  ])("uses $origin cookie security for Feishu login, CSRF and logout", async (scenario) => {
    const database = initializeDatabase(":memory:");
    const app = createApp({
      config: loadConfig({
        LARK_CODEX_ENV: "test",
        LARK_CODEX_AUTH_MODE: "feishu",
        LARK_CODEX_ORIGIN: scenario.origin,
        LARK_CODEX_ALLOWED_HOSTS: scenario.host,
        LARK_CODEX_FEISHU_APP_ID: "cli_test",
        LARK_CODEX_FEISHU_APP_SECRET: "secret-for-test",
      }),
      database,
      identityProvider: {
        kind: "feishu",
        async exchangeCode() {
          return {
            identity: { kind: "feishu", tenantKey: "tenant-cookie", userId: "user-cookie" },
            name: "Cookie 测试成员",
            avatarUrl: null,
          };
        },
      },
    });
    openApps.push(app);
    const trustedHeaders = { host: scenario.host, origin: scenario.origin };
    const wrongHost = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: { host: "evil.example", origin: scenario.origin },
      payload: { code: "authorization-code" },
    });
    expect(wrongHost.statusCode).toBe(400);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/feishu/exchange",
      headers: trustedHeaders,
      payload: { code: "authorization-code" },
    });

    expect(login.statusCode).toBe(201);
    const sessionCookie = login.cookies.find((cookie) => cookie.name === scenario.sessionName);
    const csrfCookie = login.cookies.find((cookie) => cookie.name === scenario.csrfName);
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(csrfCookie).toMatchObject({ sameSite: "Lax", path: "/" });
    expect(csrfCookie?.httpOnly).toBeUndefined();
    expect(Boolean(sessionCookie?.secure)).toBe(scenario.secure);
    expect(Boolean(csrfCookie?.secure)).toBe(scenario.secure);
    expect(login.cookies.some((cookie) => cookie.name.startsWith("__Host-"))).toBe(scenario.secure);

    const cookies = cookieHeader(login);
    const withoutCsrfHeader = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: { ...trustedHeaders, cookie: cookies },
    });
    expect(withoutCsrfHeader.statusCode).toBe(403);
    expect(withoutCsrfHeader.json().error.code).toBe("CSRF_INVALID");

    const crossSiteLogout = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: {
        host: scenario.host,
        origin: scenario.secure ? "https://evil.example" : "http://8.8.8.8:47823",
        cookie: cookies,
        "x-csrf-token": login.json().data.csrfToken,
      },
    });
    expect(crossSiteLogout.statusCode).toBe(403);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: {
        ...trustedHeaders,
        cookie: cookies,
        "x-csrf-token": login.json().data.csrfToken,
      },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies.map((cookie) => cookie.name).sort()).toEqual(
      [
        scenario.csrfName,
        scenario.sessionName,
        scenario.csrfName.replace("lark_codex_", "lark_taskboard_"),
        scenario.sessionName.replace("lark_codex_", "lark_taskboard_"),
      ].sort(),
    );
    expect(logout.cookies.every((cookie) => Boolean(cookie.secure) === scenario.secure)).toBe(true);

    const expiredSession = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: scenario.host, cookie: cookies },
    });
    expect(expiredSession.statusCode).toBe(401);
  });
});

describe("identity service", () => {
  it("refreshes verified Feishu profiles and restores access after a fresh login", async () => {
    const database = initializeDatabase(":memory:");
    openDatabases.push(database);
    let avatarUrl: string | null = "https://example.com/first.png";
    const service = new IdentityService({
      database,
      sessionTtlSeconds: 300,
      provider: {
        kind: "feishu",
        async exchangeCode() {
          return {
            identity: { kind: "feishu", tenantKey: "tenant", userId: "member" },
            name: "飞书名称",
            avatarUrl,
          };
        },
      },
    });
    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
      )
      .run('["feishu","tenant","member"]', "tenant", "member", "本地名称", "member");
    const first = await service.exchangeCode("first");
    expect(first.actor.avatarUrl).toBe(avatarUrl);
    avatarUrl = "https://example.com/second.png";
    const second = await service.exchangeCode("second");
    expect(second.actor).toMatchObject({ avatarUrl, name: "飞书名称", role: "member" });
    expect(service.authenticate(first.sessionToken).actor.avatarUrl).toBe(avatarUrl);
    avatarUrl = null;
    const missing = await service.exchangeCode("missing-avatar");
    expect(missing.actor.avatarUrl).toBe("https://example.com/second.png");
    database.prepare("UPDATE identities SET active = 0").run();
    expect(() => service.authenticate(first.sessionToken)).toThrow(AppError);
    avatarUrl = "https://example.com/restored.png";
    const restored = await service.exchangeCode("fresh-feishu-login");
    expect(restored.actor.avatarUrl).toBe(avatarUrl);
    expect(service.authenticate(restored.sessionToken).actor.identity).toEqual(
      first.actor.identity,
    );
  });

  it("enrolls each provider-verified account without creating other users or administrators", async () => {
    const database = initializeDatabase(":memory:");
    openDatabases.push(database);
    const service = new IdentityService({
      database,
      sessionTtlSeconds: 300,
      provider: {
        kind: "feishu",
        async exchangeCode(code) {
          if (code === "invalid") throw new Error("Rejected by Feishu");
          return {
            identity: { kind: "feishu", tenantKey: "tenant-1", userId: `user-${code}` },
            name: `成员 ${code}`,
            avatarUrl: null,
          };
        },
      },
    });
    await expect(service.exchangeCode("invalid")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(database.prepare("SELECT count(*) FROM identities").pluck().get()).toBe(0);
    const first = await service.exchangeCode("first");
    const second = await service.exchangeCode("second");
    expect(first.actor.role).toBe("member");
    expect(second.actor.role).toBe("member");
    expect(
      database.prepare("SELECT user_id, role, active FROM identities ORDER BY user_id").all(),
    ).toEqual([
      { user_id: "user-first", role: "member", active: 1 },
      { user_id: "user-second", role: "member", active: 1 },
    ]);
    expect(service.authenticate(second.sessionToken).actor.identity).toEqual(second.actor.identity);
  });

  it("expires sessions using server time", async () => {
    const database = initializeDatabase(":memory:");
    openDatabases.push(database);
    let now = new Date("2026-08-30T10:00:00.000Z");
    const service = new IdentityService({
      database,
      provider: new DevelopmentIdentityAdapter(),
      sessionTtlSeconds: 300,
      now: () => now,
    });
    service.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
    const grant = await service.loginDevelopment();

    expect(service.authenticate(grant.sessionToken).actor.role).toBe("admin");
    now = new Date("2026-08-30T10:06:00.000Z");
    expect(() => service.authenticate(grant.sessionToken)).toThrow(AppError);
  });

  it("grants every project action to verified Feishu users without trusting self-reported roles", async () => {
    const database = initializeDatabase(":memory:");
    openDatabases.push(database);
    const service = new IdentityService({
      database,
      sessionTtlSeconds: 300,
      provider: {
        kind: "feishu",
        async exchangeCode() {
          return {
            identity: { kind: "feishu", tenantKey: "tenant", userId: "member" },
            name: "成员",
            avatarUrl: null,
          };
        },
      },
    });
    const projectId = "00000000-0000-4000-8000-000000000010";
    database
      .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, 'TEST', '项目')")
      .run(projectId);
    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', 'tenant', 'member', '成员', 'member')",
      )
      .run('["feishu","tenant","member"]');
    const actor = {
      identity: { kind: "feishu", tenantKey: "tenant", userId: "member" } as FeishuIdentityRef,
      name: "伪造管理员",
      avatarUrl: null,
      role: "admin" as const,
    };
    expect(() => service.authorizeProject(actor, projectId, "read")).toThrow(AppError);
    const grant = await service.exchangeCode("verified");
    database
      .prepare(
        "INSERT INTO project_members (project_id, identity_key, role) VALUES (?, ?, 'viewer')",
      )
      .run(projectId, identityKey(grant.actor.identity));
    for (const action of ["read", "write", "execute", "admin"] as const) {
      expect(() => service.authorizeProject(grant.actor, projectId, action)).not.toThrow();
    }
    const impostor = {
      ...grant.actor,
      role: "admin" as const,
      identity: { ...actor.identity, tenantKey: "other-tenant" },
    };
    expect(() => service.authorizeProject(impostor, projectId, "read")).toThrow(AppError);
    database
      .prepare("UPDATE identities SET active = 0 WHERE identity_key = ?")
      .run(identityKey(grant.actor.identity));
    expect(() => service.authorizeProject(grant.actor, projectId, "read")).toThrow(AppError);
  });

  it("keeps one natural user across app-specific open IDs without changing memberships", async () => {
    const database = initializeDatabase(":memory:");
    openDatabases.push(database);
    const identity: FeishuIdentityRef = {
      kind: "feishu",
      tenantKey: "tenant",
      userId: "same-user",
    };
    database
      .prepare(
        "INSERT INTO identities(identity_key,kind,tenant_key,user_id,name,role) VALUES (?,'feishu','tenant','same-user','Member','member')",
      )
      .run(identityKey(identity));
    const services = ["app-a", "app-b"].map(
      (appId) =>
        new IdentityService({
          database,
          sessionTtlSeconds: 300,
          provider: new FeishuIdentityAdapter({
            appId,
            appSecret: "synthetic-secret",
            apiBaseUrl: "https://open.feishu.cn",
            fetcher: async (input) => {
              const url = new URL(input instanceof Request ? input.url : input);
              if (url.pathname.endsWith("/app_access_token/internal"))
                return Response.json({
                  code: 0,
                  msg: "ok",
                  app_access_token: "app-token",
                  expire: 7200,
                });
              if (url.pathname.endsWith("/access_token"))
                return Response.json({ code: 0, msg: "ok", data: { access_token: "user-token" } });
              return Response.json({
                code: 0,
                msg: "ok",
                data: {
                  tenant_key: "tenant",
                  user_id: "same-user",
                  open_id: `open-${appId}`,
                  name: "Member",
                  avatar_url: "https://example.com/avatar.png",
                },
              });
            },
          }),
        }),
    );
    const first = await services[0]!.exchangeCode("code-a");
    const second = await services[1]!.exchangeCode("code-b");
    expect(first.actor.identity).toEqual(identity);
    expect(second.actor.identity).toEqual(identity);
    expect(database.prepare("SELECT identity_key,role FROM identities").all()).toEqual([
      { identity_key: '["feishu","tenant","same-user"]', role: "member" },
    ]);
    expect(database.prepare("SELECT count(*) FROM sessions").pluck().get()).toBe(2);
  });
});

describe("Feishu identity adapter", () => {
  it("uses the documented three-step exchange and caches the app token", async () => {
    const requestedPaths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requestedPaths.push(url.pathname);

      if (url.pathname.endsWith("/app_access_token/internal")) {
        return Response.json({ code: 0, msg: "ok", app_access_token: "app-token", expire: 7200 });
      }
      if (url.pathname.endsWith("/access_token")) {
        return Response.json({ code: 0, msg: "ok", data: { access_token: "user-token" } });
      }
      return Response.json({
        code: 0,
        msg: "ok",
        data: {
          tenant_key: "tenant-1",
          open_id: "open-1",
          user_id: "user-1",
          name: "飞书成员",
          avatar_url: "https://example.com/avatar.png",
        },
      });
    };
    const adapter = new FeishuIdentityAdapter({
      appId: "cli_test",
      appSecret: "secret-for-test",
      apiBaseUrl: "https://open.feishu.cn",
      fetcher,
    });

    await expect(adapter.exchangeCode("authorization-code-1")).resolves.toMatchObject({
      identity: { kind: "feishu", tenantKey: "tenant-1", userId: "user-1" },
    });
    await adapter.exchangeCode("authorization-code-2");

    expect(
      requestedPaths.filter((path) => path.endsWith("/app_access_token/internal")),
    ).toHaveLength(1);
    expect(requestedPaths).toEqual([
      "/open-apis/auth/v3/app_access_token/internal",
      "/open-apis/authen/v1/access_token",
      "/open-apis/authen/v1/user_info",
      "/open-apis/authen/v1/access_token",
      "/open-apis/authen/v1/user_info",
    ]);
  });

  it("rejects a valid open ID when the provider omits user_id instead of falling back", async () => {
    const adapter = new FeishuIdentityAdapter({
      appId: "app",
      appSecret: "synthetic-secret",
      apiBaseUrl: "https://open.feishu.cn",
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname.endsWith("/app_access_token/internal"))
          return Response.json({ code: 0, msg: "ok", app_access_token: "app-token", expire: 7200 });
        if (url.pathname.endsWith("/access_token"))
          return Response.json({ code: 0, msg: "ok", data: { access_token: "user-token" } });
        return Response.json({
          code: 0,
          msg: "ok",
          data: {
            tenant_key: "tenant",
            open_id: "open-only",
            name: "Member",
            avatar_url: "https://example.com/avatar.png",
          },
        });
      },
    });
    await expect(adapter.exchangeCode("authorization-code")).rejects.toThrow(/user_id/);
  });
});
