import { identityKey } from "@codexboard/contracts";
import {
  CreateGitResourceCommandSchema,
  DeleteGitResourceCommandSchema,
  EntityIdSchema,
} from "@codexboard/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../app-error.js";
import type { AppConfig } from "../../config.js";
import { sessionCookieNames, type IdentityService } from "../identity/index.js";
import type { Taskboard } from "../taskboard/taskboard.js";
import type { GitManagement } from "./git-management.js";

export function registerGitManagementRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    identityService: IdentityService;
    taskboard: Taskboard;
    gitManagement: GitManagement;
  },
) {
  function authorize(request: FastifyRequest, mutation = false) {
    const names = sessionCookieNames(options.config, request.cookies);
    const session = options.identityService.authenticate(request.cookies[names.session]);
    options.identityService.assertBoardAccess(session.actor);
    if (mutation) {
      const token = request.headers["x-csrf-token"];
      options.identityService.assertCsrf(
        session,
        typeof token === "string" ? token : undefined,
        request.cookies[names.csrf],
      );
    }
    const { projectId } = z.object({ projectId: EntityIdSchema }).parse(request.params);
    if (
      !options.taskboard
        .listProjects(session.actor)
        .some(
          (project) =>
            project.id === projectId && project.kind === "codex" && project.syncState === "synced",
        )
    )
      throw new AppError("INVALID_REQUEST", 409, "请选择可用的本地项目");
    return {
      projectId,
      principalKey: identityKey(session.actor.identity),
      userName: session.actor.name,
    };
  }
  app.get("/api/v1/projects/:projectId/git", async (request) => {
    const { projectId } = authorize(request);
    return { data: await options.gitManagement.read(projectId) };
  });
  app.post("/api/v1/projects/:projectId/git", async (request, reply) => {
    const { projectId, principalKey, userName } = authorize(request, true);
    await options.gitManagement.create(
      projectId,
      CreateGitResourceCommandSchema.parse(request.body),
      principalKey,
      { kind: "user", userKey: principalKey, userName },
    );
    return reply.code(201).send({ data: { ok: true } });
  });
  app.delete("/api/v1/projects/:projectId/git", async (request) => {
    const { projectId, principalKey } = authorize(request, true);
    await options.gitManagement.remove(
      projectId,
      DeleteGitResourceCommandSchema.parse(request.body),
      principalKey,
    );
    return { data: { ok: true } };
  });
}
