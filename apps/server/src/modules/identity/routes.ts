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
} from "@lark-taskboard/contracts";
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

export function sessionCookieNames(config: AppConfig): CookieNames {
  const prefix = new URL(config.LARK_TASKBOARD_ORIGIN).protocol === "https:" ? "__Host-" : "";
  return {
    session: `${prefix}lark_taskboard_session`,
    csrf: `${prefix}lark_taskboard_csrf`,
  };
}

function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  grant: SessionGrant,
): SessionView {
  const names = sessionCookieNames(config);
  const secure = new URL(config.LARK_TASKBOARD_ORIGIN).protocol === "https:";
  const maxAge = config.LARK_TASKBOARD_SESSION_TTL_SECONDS;
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
    config.LARK_TASKBOARD_AUTH_MODE === "feishu" &&
    config.LARK_TASKBOARD_FEISHU_APP_ID &&
    config.LARK_TASKBOARD_FEISHU_APP_SECRET
      ? new FeishuJsapiService({
          appId: config.LARK_TASKBOARD_FEISHU_APP_ID,
          appSecret: config.LARK_TASKBOARD_FEISHU_APP_SECRET,
          apiBaseUrl: config.LARK_TASKBOARD_FEISHU_API_BASE_URL,
          origin: config.LARK_TASKBOARD_ORIGIN,
        })
      : null;
  app.get("/api/v1/auth/feishu/jsapi-config", async (request, reply) => {
    service.authenticate(request.cookies[names.session]);
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
    const session = service.authenticate(request.cookies[names.session]);
    service.authenticatedFeishuPrincipal(session.actor.identity);
    const { requestId } = requestParams.parse(request.params);
    reply.header("Cache-Control", "no-store");
    return { data: cliAuthOperation(() => cliAuth.inspect(requestId)) };
  });
  app.post("/api/v1/auth/cli/requests/:requestId/approve", async (request, reply) => {
    const session = service.authenticate(request.cookies[names.session]);
    const header = request.headers["x-csrf-token"];
    service.assertCsrf(
      session,
      typeof header === "string" ? header : undefined,
      request.cookies[names.csrf],
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
      authMode: config.LARK_TASKBOARD_AUTH_MODE,
      feishuAppId:
        config.LARK_TASKBOARD_AUTH_MODE === "feishu" ? config.LARK_TASKBOARD_FEISHU_APP_ID : null,
    }),
  }));

  if (config.LARK_TASKBOARD_AUTH_MODE === "development") {
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
    const context = service.authenticate(request.cookies[names.session]);
    const csrfToken = request.cookies[names.csrf];

    return {
      data: SessionViewSchema.parse({
        actor: context.actor,
        csrfToken,
        expiresAt: context.expiresAt,
      }),
    };
  });

  app.post("/api/v1/session/logout", async (request, reply) => {
    const context = service.authenticate(request.cookies[names.session]);
    const headerToken = request.headers["x-csrf-token"];
    service.assertCsrf(
      context,
      typeof headerToken === "string" ? headerToken : undefined,
      request.cookies[names.csrf],
    );
    service.revoke(context);

    const secure = new URL(config.LARK_TASKBOARD_ORIGIN).protocol === "https:";
    reply.clearCookie(names.session, { path: "/", secure, sameSite: "lax" });
    reply.clearCookie(names.csrf, { path: "/", secure, sameSite: "lax" });
    await reply.code(204).send();
  });
}
