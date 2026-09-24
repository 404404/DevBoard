import type { FastifyInstance } from "fastify";

import { AppError } from "../../app-error.js";
import type { AppConfig } from "../../config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function registerRequestBoundary(app: FastifyInstance, config: AppConfig): void {
  const allowedHosts = new Set(config.CODEXBOARD_ALLOWED_HOSTS);

  app.addHook("onRequest", async (request) => {
    const host = request.headers.host?.trim().toLowerCase();
    if (!host || !allowedHosts.has(host)) {
      throw new AppError("INVALID_REQUEST", 400, "请求 Host 不受信任");
    }

    const origin = request.headers.origin;
    if (origin && origin !== config.CODEXBOARD_ORIGIN) {
      throw new AppError("FORBIDDEN", 403, "请求 Origin 不受信任");
    }

    if (!SAFE_METHODS.has(request.method) && origin !== config.CODEXBOARD_ORIGIN) {
      throw new AppError("FORBIDDEN", 403, "写请求必须来自受信任 Origin");
    }

    if (
      config.CODEXBOARD_ENV === "production" &&
      request.url !== "/api/health" &&
      new URL(config.CODEXBOARD_ORIGIN).protocol === "https:" &&
      request.protocol !== "https"
    ) {
      throw new AppError("FORBIDDEN", 403, "请通过配置的 HTTPS 反向代理访问 DevBoard");
    }
  });
}
