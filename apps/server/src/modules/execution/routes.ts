import {
  EntityIdSchema,
  IdempotencyKeySchema,
  InteractionDecisionSchema,
  SubmitExecutionCommandSchema,
  TEMPORARY_PROJECT_ID,
} from "@codexboard/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import type { AppConfig } from "../../config.js";
import { sessionCookieNames, type IdentityService } from "../identity/index.js";
import type { ProjectRegistry } from "../project-registry/index.js";
import type { Taskboard } from "../taskboard/index.js";
import type { ExecutionQueue, JobRequestContext } from "./execution-queue.js";
import type { InteractionService } from "./interaction-service.js";

const TaskParamsSchema = z.object({ taskId: EntityIdSchema });
const JobParamsSchema = z.object({ jobId: EntityIdSchema });
const InteractionParamsSchema = z.object({ interactionId: EntityIdSchema });

interface ExecutionRoutesOptions {
  readonly config: AppConfig;
  readonly identityService: IdentityService;
  readonly taskboard: Taskboard;
  readonly projectRegistry: ProjectRegistry;
  readonly queue: ExecutionQueue;
  readonly interactions: InteractionService;
  readonly schedule: () => void;
}

function session(request: FastifyRequest, config: AppConfig, identityService: IdentityService) {
  const names = sessionCookieNames(config, request.cookies);
  return identityService.authenticate(request.cookies[names.session]);
}

function mutationContext(
  request: FastifyRequest,
  config: AppConfig,
  identityService: IdentityService,
): JobRequestContext {
  const names = sessionCookieNames(config, request.cookies);
  const current = identityService.authenticate(request.cookies[names.session]);
  const csrfHeader = request.headers["x-csrf-token"];
  identityService.assertCsrf(
    current,
    typeof csrfHeader === "string" ? csrfHeader : undefined,
    request.cookies[names.csrf],
  );
  const idempotencyHeader = request.headers["idempotency-key"];
  return {
    actor: current.actor,
    idempotencyKey: IdempotencyKeySchema.parse(
      typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    ),
    requestId: request.id,
  };
}

export function registerExecutionRoutes(
  app: FastifyInstance,
  options: ExecutionRoutesOptions,
): void {
  const { config, identityService, taskboard, projectRegistry, queue, interactions } = options;

  app.get("/api/v1/tasks/:taskId/jobs", async (request) => {
    const current = session(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    taskboard.readTask(taskId, current.actor);
    return { data: queue.listTaskJobs(taskId) };
  });

  app.get("/api/v1/jobs/:jobId", async (request) => {
    const current = session(request, config, identityService);
    const { jobId } = JobParamsSchema.parse(request.params);
    const job = queue.readJob(jobId);
    taskboard.readTask(job.taskId, current.actor);
    return { data: job };
  });

  app.post("/api/v1/tasks/:taskId/jobs/start", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = SubmitExecutionCommandSchema.parse(request.body ?? {});
    const task = taskboard.readTask(taskId, context.actor);
    if (!task.permissions.canExecute) throw new AppError("FORBIDDEN", 403, "没有该任务执行权限");
    if (queue.primaryThread(taskId)) {
      throw new AppError("INVALID_REQUEST", 409, "任务已有主 Thread，请使用继续执行");
    }
    if (task.projectId === TEMPORARY_PROJECT_ID) {
      throw new AppError("INVALID_REQUEST", 409, "临时任务需要先分配到 Codex 项目才能启动");
    }
    const execution = await projectRegistry.resolveExecutionContext(
      task.projectId,
      task.developmentContextId ?? undefined,
    );
    const job = queue.submit(
      {
        taskId,
        kind: "start",
        executionKey: execution.cwd,
        workContext: {
          projectId: task.projectId,
          developmentContextId: task.developmentContextId,
          cwd: execution.cwd,
          branch: execution.branch,
          headSha: execution.headSha,
          prompt: command.prompt ?? buildPrompt(task.identifier, task.title, task.description),
        },
        explicitPrompt: command.prompt !== undefined,
        maxAttempts: 2,
      },
      context,
    );
    options.schedule();
    await reply.code(202).send({ data: job });
  });

  app.post("/api/v1/tasks/:taskId/jobs/continue", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = SubmitExecutionCommandSchema.parse(request.body ?? {});
    const task = taskboard.readTask(taskId, context.actor);
    if (!task.permissions.canExecute) throw new AppError("FORBIDDEN", 403, "没有该任务执行权限");
    const thread = queue.primaryThread(taskId);
    if (!thread) {
      throw new AppError("INVALID_REQUEST", 409, "任务尚未绑定 Codex Thread");
    }
    if (task.projectId === TEMPORARY_PROJECT_ID && !isAbsolute(thread.cwd)) {
      throw new AppError("INVALID_REQUEST", 409, "历史 Thread 工作目录无效");
    }
    const execution =
      task.projectId === TEMPORARY_PROJECT_ID
        ? {
            projectId: task.projectId,
            developmentContextId: null,
            cwd: thread.cwd,
            branch: null,
            headSha: null,
          }
        : await projectRegistry.resolveExecutionContext(
            task.projectId,
            task.developmentContextId ?? undefined,
          );
    const job = queue.submit(
      {
        taskId,
        taskThreadId: thread.id,
        kind: "continue",
        executionKey: execution.cwd,
        workContext: {
          projectId: task.projectId,
          developmentContextId: task.developmentContextId,
          cwd: execution.cwd,
          branch: execution.branch,
          headSha: execution.headSha,
          prompt:
            command.prompt ??
            (thread.lastTurnId
              ? `继续处理 ${task.identifier}：${task.title}`
              : buildPrompt(task.identifier, task.title, task.description)),
        },
        explicitPrompt: command.prompt !== undefined,
        maxAttempts: 2,
      },
      context,
    );
    options.schedule();
    await reply.code(202).send({ data: job });
  });

  app.post("/api/v1/jobs/:jobId/cancel", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const { jobId } = JobParamsSchema.parse(request.params);
    const job = queue.readJob(jobId);
    const task = taskboard.readTask(job.taskId, context.actor);
    if (!task.permissions.canExecute) throw new AppError("FORBIDDEN", 403, "没有该任务执行权限");
    const result = queue.requestCancel(jobId, context);
    options.schedule();
    await reply.code(202).send({ data: result });
  });

  app.get("/api/v1/jobs/:jobId/interactions", async (request) => {
    const current = session(request, config, identityService);
    const { jobId } = JobParamsSchema.parse(request.params);
    const job = queue.readJob(jobId);
    taskboard.readTask(job.taskId, current.actor);
    return { data: interactions.listForJob(jobId) };
  });

  app.post("/api/v1/interactions/:interactionId/respond", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { interactionId } = InteractionParamsSchema.parse(request.params);
    const decision = InteractionDecisionSchema.parse(request.body);
    return { data: interactions.respond(interactionId, decision, context.actor, request.id) };
  });
}

function buildPrompt(identifier: string, title: string, description: string): string {
  return [`请完成任务 ${identifier}：${title}`, description].filter(Boolean).join("\n\n");
}
