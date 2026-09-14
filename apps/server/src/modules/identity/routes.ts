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
} from "@lark-codex/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../../config.js";
import type { IdentityService, SessionGrant } from "./identity-service.js";

interface IdentityRoutesOptions {
  readonly config: AppConfig;
  readonly service: IdentityService;
  readonly cliAuth: CliAuthService;
}

interface CookieNames {
  readonly session: string;
  readonly csrf: string;
}

export function sessionCookieNames(
  config: AppConfig,
  cookies?: Readonly<Record<string, string | undefined>>,
): CookieNames {
  const prefix = new URL(config.LARK_CODEX_ORIGIN).protocol === "https:" ? "__Host-" : "";
  const current = {
    session: `${prefix}lark_codex_session`,
    csrf: `${prefix}lark_codex_csrf`,
  };
  // Do not combine a new identity with a legacy CSRF token. Even an empty new
  // cookie selects the new pair and must fail normal authentication checks.
  if (cookies && !Object.hasOwn(cookies, current.session) && !Object.hasOwn(cookies, current.csrf))
    return {
      session: `${prefix}lark_taskboard_session`,
      csrf: `${prefix}lark_taskboard_csrf`,
    };
  return current;
}

function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  grant: SessionGrant,
): SessionView {
  const names = sessionCookieNames(config);
  const secure = new URL(config.LARK_CODEX_ORIGIN).protocol === "https:";
  const maxAge = config.LARK_CODEX_SESSION_TTL_SECONDS;
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
  const { config, service, cliAuth } = options;
  const names = sessionCookieNames(config);
  const jsapi =
    config.LARK_CODEX_AUTH_MODE === "feishu" &&
    config.LARK_CODEX_FEISHU_APP_ID &&
    config.LARK_CODEX_FEISHU_APP_SECRET
      ? new FeishuJsapiService({
          appId: config.LARK_CODEX_FEISHU_APP_ID,
          appSecret: config.LARK_CODEX_FEISHU_APP_SECRET,
          apiBaseUrl: config.LARK_CODEX_FEISHU_API_BASE_URL,
          origin: config.LARK_CODEX_ORIGIN,
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

  app.get("/api/v1/auth/config", async () => ({
    data: AuthBootstrapSchema.parse({
      authMode: config.LARK_CODEX_AUTH_MODE,
      feishuAppId:
        config.LARK_CODEX_AUTH_MODE === "feishu" ? config.LARK_CODEX_FEISHU_APP_ID : null,
    }),
  }));

  if (config.LARK_CODEX_AUTH_MODE === "development") {
    app.post("/api/v1/auth/development", async (_request, reply) => {
      const grant = await service.loginDevelopment();
      await reply.code(201).send({ data: setSessionCookies(reply, config, grant) });
    });
  } else {
    app.post("/api/v1/auth/feishu/exchange", async (request, reply) => {
      const command = ExchangeFeishuCodeSchema.parse(request.body);
      const grant = await service.exchangeCode(command.code);
      await reply.code(201).send({ data: setSessionCookies(reply, config, grant) });
    });
  }

  app.get("/api/v1/session", async (request) => {
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

    const secure = new URL(config.LARK_CODEX_ORIGIN).protocol === "https:";
    reply.clearCookie(names.session, { path: "/", secure, sameSite: "lax" });
    reply.clearCookie(names.csrf, { path: "/", secure, sameSite: "lax" });
    const legacy = sessionCookieNames(config, {});
    reply.clearCookie(legacy.session, { path: "/", secure, sameSite: "lax" });
    reply.clearCookie(legacy.csrf, { path: "/", secure, sameSite: "lax" });
    await reply.code(204).send();
  });
}
