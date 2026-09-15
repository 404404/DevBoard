import type { WebAccountService } from "./web-account-service.js";
import { FeishuJsapiService } from "./feishu-jsapi-service.js";
import { AppError } from "../../app-error.js";
import { z } from "zod";
import { cliAuthOperation, type CliAuthService } from "./cli-auth-service.js";
import {
  AuthBootstrapSchema,
  FeishuIdentityRefSchema,
  ExchangeFeishuCodeSchema,
  SessionViewSchema,
  type SessionView,
} from "@codexboard/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../../config.js";
import type { IdentityService, SessionGrant } from "./identity-service.js";

interface IdentityRoutesOptions {
  readonly config: AppConfig;
  readonly service: IdentityService;
  readonly cliAuth: CliAuthService;
  readonly webAccounts: WebAccountService;
}

interface CookieNames {
  readonly session: string;
  readonly csrf: string;
}

export function sessionCookieNames(
  config: AppConfig,
  cookies?: Readonly<Record<string, string | undefined>>,
): CookieNames {
  const prefix = new URL(config.CODEXBOARD_ORIGIN).protocol === "https:" ? "__Host-" : "";
  const current = {
    session: `${prefix}codexboard_session`,
    csrf: `${prefix}codexboard_csrf`,
  };
  // Select a whole generation; even an empty newer cookie prevents fallback.
  if (
    cookies &&
    !Object.hasOwn(cookies, current.session) &&
    !Object.hasOwn(cookies, current.csrf)
  ) {
    for (const brand of ["lark_codex", "lark_taskboard"]) {
      const previous = { session: `${prefix}${brand}_session`, csrf: `${prefix}${brand}_csrf` };
      if (Object.hasOwn(cookies, previous.session) || Object.hasOwn(cookies, previous.csrf))
        return previous;
    }
  }
  return current;
}

function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  grant: SessionGrant,
): SessionView {
  const names = sessionCookieNames(config);
  const secure = new URL(config.CODEXBOARD_ORIGIN).protocol === "https:";
  const maxAge = config.CODEXBOARD_SESSION_TTL_SECONDS;
  const common = {
    path: "/",
    secure,
    sameSite: "lax" as const,
    maxAge,
  };

  reply.setCookie(names.session, grant.sessionToken, {
    ...common,
    httpOnly: true,
  });
  reply.setCookie(names.csrf, grant.csrfToken, {
    ...common,
    httpOnly: false,
  });

  return SessionViewSchema.parse({
    actor: grant.actor,
    csrfToken: grant.csrfToken,
    expiresAt: grant.expiresAt,
  });
}

export function registerIdentityRoutes(app: FastifyInstance, options: IdentityRoutesOptions): void {
  const { config, service, cliAuth, webAccounts } = options;
  const webLoginSecure = new URL(config.CODEXBOARD_ORIGIN).protocol === "https:";
  app.post("/api/v1/auth/web/login", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!webLoginSecure || !webAccounts.enabled())
      throw new AppError("FORBIDDEN", 403, "Web 登录未启用；请在本机应用创建账号并配置 HTTPS");
    const accountId = await webAccounts.verify(request.body);
    return reply
      .code(201)
      .send({ data: setSessionCookies(reply, config, service.loginWebAccount(accountId)) });
  });
  const names = sessionCookieNames(config);
  const jsapi =
    config.CODEXBOARD_AUTH_MODE === "feishu" &&
    config.CODEXBOARD_FEISHU_APP_ID &&
    config.CODEXBOARD_FEISHU_APP_SECRET
      ? new FeishuJsapiService({
          appId: config.CODEXBOARD_FEISHU_APP_ID,
          appSecret: config.CODEXBOARD_FEISHU_APP_SECRET,
          apiBaseUrl: config.CODEXBOARD_FEISHU_API_BASE_URL,
          origin: config.CODEXBOARD_ORIGIN,
        })
      : null;
  app.get("/api/v1/auth/feishu/jsapi-config", async (request, reply) => {
    service.authenticate(request.cookies[sessionCookieNames(config, request.cookies).session]);
    reply.header("Cache-Control", "no-store");
    if (!jsapi) throw new AppError("INVALID_REQUEST", 400, "当前环境未配置飞书图片功能");
    const { url } = z
      .object({ url: z.url().max(8192) })
      .strict()
      .parse(request.query);
    return { data: await jsapi.config(url) };
  });

  const requestParams = z.object({ requestId: z.string().min(1).max(200) });
  app.get("/api/v1/auth/cli/requests/:requestId", async (request, reply) => {
    const session = service.authenticate(
      request.cookies[sessionCookieNames(config, request.cookies).session],
    );
    service.authenticatedFeishuPrincipal(session.actor.identity);
    const { requestId } = requestParams.parse(request.params);
    reply.header("Cache-Control", "no-store");
    return { data: cliAuthOperation(() => cliAuth.inspect(requestId)) };
  });
  app.post("/api/v1/auth/cli/requests/:requestId/approve", async (request, reply) => {
    const session = service.authenticate(
      request.cookies[sessionCookieNames(config, request.cookies).session],
    );
    const header = request.headers["x-csrf-token"];
    service.assertCsrf(
      session,
      typeof header === "string" ? header : undefined,
      request.cookies[sessionCookieNames(config, request.cookies).csrf],
    );
    z.object({})
      .strict()
      .parse(request.body ?? {});
    const actor = service.authenticatedFeishuPrincipal(session.actor.identity);
    const { requestId } = requestParams.parse(request.params);
    reply.header("Cache-Control", "no-store");
    // This identity only comes from the authenticated browser session, never from the payload.
    return {
      data: cliAuthOperation(() =>
        cliAuth.approve(requestId, FeishuIdentityRefSchema.parse(actor.identity)),
      ),
    };
  });

  app.get("/api/v1/auth/config", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      data: AuthBootstrapSchema.parse({
        authMode: config.CODEXBOARD_AUTH_MODE,
        webLoginEnabled: webLoginSecure && webAccounts.enabled(),
        feishuAppId:
          config.CODEXBOARD_AUTH_MODE === "feishu" ? config.CODEXBOARD_FEISHU_APP_ID : null,
      }),
    };
  });

  if (config.CODEXBOARD_AUTH_MODE === "development") {
    app.post("/api/v1/auth/development", async (_request, reply) => {
      const grant = await service.loginDevelopment();
      await reply.code(201).send({ data: setSessionCookies(reply, config, grant) });
    });
  } else if (config.CODEXBOARD_AUTH_MODE === "feishu") {
    app.post("/api/v1/auth/feishu/exchange", async (request, reply) => {
      const command = ExchangeFeishuCodeSchema.parse(request.body);
      const grant = await service.exchangeCode(command.code);
      await reply.code(201).send({ data: setSessionCookies(reply, config, grant) });
    });
  }

  app.get("/api/v1/session", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const context = service.authenticate(
      request.cookies[sessionCookieNames(config, request.cookies).session],
    );
    const csrfToken = request.cookies[sessionCookieNames(config, request.cookies).csrf];

    return {
      data: SessionViewSchema.parse({
        actor: context.actor,
        csrfToken,
        expiresAt: context.expiresAt,
      }),
    };
  });

  app.post("/api/v1/session/logout", async (request, reply) => {
    const context = service.authenticate(
      request.cookies[sessionCookieNames(config, request.cookies).session],
    );
    const headerToken = request.headers["x-csrf-token"];
    service.assertCsrf(
      context,
      typeof headerToken === "string" ? headerToken : undefined,
      request.cookies[sessionCookieNames(config, request.cookies).csrf],
    );
    service.revoke(context);

    const secure = new URL(config.CODEXBOARD_ORIGIN).protocol === "https:";
    reply.clearCookie(names.session, { path: "/", secure, sameSite: "lax" });
    reply.clearCookie(names.csrf, { path: "/", secure, sameSite: "lax" });
    for (const brand of ["lark_codex", "lark_taskboard"]) {
      const prefix = secure ? "__Host-" : "";
      reply.clearCookie(`${prefix}${brand}_session`, { path: "/", secure, sameSite: "lax" });
      reply.clearCookie(`${prefix}${brand}_csrf`, { path: "/", secure, sameSite: "lax" });
    }
    await reply.code(204).send();
  });
}
