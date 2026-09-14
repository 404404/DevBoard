import { existsSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AppError } from "../app-error.js";
import type { AppConfig } from "../config.js";

const WildcardParamsSchema = z.object({ "*": z.string() });

export function registerProductionWeb(app: FastifyInstance, config: AppConfig): void {
  if (config.LARK_TASKBOARD_ENV !== "production") return;
  app.register(async (web) => {
    await web.register(fastifyStatic, {
      root: config.LARK_TASKBOARD_WEB_ROOT,
      wildcard: false,
      index: false,
    });
    web.get("/", async (_request, reply) => reply.sendFile("index.html"));
    web.get("/*", async (request, reply) => {
      const path = WildcardParamsSchema.parse(request.params)["*"];
      if (path === "api" || path.startsWith("api/")) {
        throw new AppError("NOT_FOUND", 404, "请求的资源不存在");
      }
      const candidate = resolve(config.LARK_TASKBOARD_WEB_ROOT, ...path.split("/"));
      const insideRoot = candidate.startsWith(`${config.LARK_TASKBOARD_WEB_ROOT}${sep}`);
      if (insideRoot && existsSync(candidate) && lstatSync(candidate).isFile()) {
        return reply.sendFile(path);
      }
      throw new AppError("NOT_FOUND", 404, "请求的资源不存在");
    });
  });
}
