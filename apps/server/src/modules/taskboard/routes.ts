import {
  ArchiveTaskCommandSchema,
  AttachmentContentTypeSchema,
  CreateCommentCommandSchema,
  CreateTaskRelationCommandSchema,
  DeleteCommentCommandSchema,
  DeleteTaskCommandSchema,
  CreateTaskCommandSchema,
  EntityIdSchema,
  IdempotencyKeySchema,
  MoveTaskCommandSchema,
  ProjectTaskCreationOptionsViewSchema,
  ReassignTaskCommandSchema,
  RestoreTaskCommandSchema,
  UpdateTaskCommandSchema,
  UpdateCommentCommandSchema,
  TEMPORARY_PROJECT_ID,
  TaskLifecycleCommandSchema,
} from "@codexboard/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { AppError } from "../../app-error.js";
import type { AttachmentService } from "../attachments/index.js";
import {
  sessionCookieNames,
  type IdentityService,
  type SessionContext,
} from "../identity/index.js";
import type { ProjectRegistry } from "../project-registry/index.js";
import type { TaskWorkspace } from "./task-workspace.js";
import type { TaskCreationService } from "./task-creation-service.js";
import type { TaskDeletionService } from "./task-deletion-service.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import type { MutationContext, Taskboard } from "./taskboard.js";

const ProjectParamsSchema = z.object({ projectId: EntityIdSchema });
const TaskParamsSchema = z.object({ taskId: EntityIdSchema });
const CommentParamsSchema = z.object({ commentId: EntityIdSchema });
const RelationParamsSchema = z.object({ taskId: EntityIdSchema, relationId: EntityIdSchema });
const AttachmentParamsSchema = z.object({ attachmentId: EntityIdSchema });
const AttachmentDownloadQuerySchema = z.object({ preview: z.literal("1").optional() });

function decodeFilenameHeader(value: unknown): string {
  const encoded = z.string().min(1).parse(value);
  try {
    return decodeURIComponent(encoded);
  } catch (cause: unknown) {
    throw new AppError("INVALID_REQUEST", 400, "附件文件名编码无效", { cause });
  }
}

interface TaskboardRoutesOptions {
  readonly config: AppConfig;
  readonly identityService: IdentityService;
  readonly taskboard: Taskboard;
  readonly taskCreation: TaskCreationService | null;
  readonly taskDeletion: TaskDeletionService;
  readonly taskLifecycle: TaskLifecycleService;
  readonly workspace: TaskWorkspace;
  readonly attachments: AttachmentService;
  readonly projectRegistry: ProjectRegistry;
}

function authenticate(
  request: FastifyRequest,
  config: AppConfig,
  identityService: IdentityService,
): SessionContext {
  const names = sessionCookieNames(config, request.cookies);
  return identityService.authenticate(request.cookies[names.session]);
}

function mutationContext(
  request: FastifyRequest,
  config: AppConfig,
  identityService: IdentityService,
): MutationContext {
  const names = sessionCookieNames(config, request.cookies);
  const session = identityService.authenticate(request.cookies[names.session]);
  const csrfHeader = request.headers["x-csrf-token"];
  identityService.assertCsrf(
    session,
    typeof csrfHeader === "string" ? csrfHeader : undefined,
    request.cookies[names.csrf],
  );
  const idempotencyHeader = request.headers["idempotency-key"];
  const idempotencyKey = IdempotencyKeySchema.parse(
    typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
  );
  return { actor: session.actor, idempotencyKey, requestId: request.id };
}

export function registerTaskboardRoutes(
  app: FastifyInstance,
  options: TaskboardRoutesOptions,
): void {
  const {
    config,
    identityService,
    taskboard,
    taskCreation,
    taskDeletion,
    taskLifecycle,
    workspace,
    attachments,
    projectRegistry,
  } = options;

  app.get("/api/v1/projects", async (request) => {
    const session = authenticate(request, config, identityService);
    return { data: taskboard.listProjects(session.actor) };
  });

  app.get("/api/v1/projects/:projectId/board", async (request) => {
    const session = authenticate(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return { data: taskboard.readBoard(projectId, session.actor) };
  });

  app.get("/api/v1/projects/:projectId/task-creation-options", async (request) => {
    const session = authenticate(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const optionsView = taskboard.readTaskCreationOptions(projectId, session.actor, () => [], {
      attachmentMaxBytes: config.CODEXBOARD_ATTACHMENT_MAX_BYTES,
    });
    if (projectId === TEMPORARY_PROJECT_ID) {
      return { data: optionsView };
    }
    const executionContext = await projectRegistry.resolveExecutionContext(projectId);
    const developmentContexts = executionContext.headSha
      ? (await projectRegistry.scanDevelopmentContexts(projectId)).filter(
          (context) =>
            context.active &&
            context.executable &&
            context.worktreeRealpath !== null &&
            context.branch !== executionContext.branch,
        )
      : [];
    return {
      data: ProjectTaskCreationOptionsViewSchema.parse({
        ...optionsView,
        developmentContexts,
        defaultDevelopmentContext: {
          id: null,
          label: executionContext.branch ?? "无",
          branch: executionContext.branch,
        },
      }),
    };
  });

  app.get("/api/v1/projects/:projectId/dashboard", async (request) => {
    const session = authenticate(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return { data: workspace.readDashboard(projectId, session.actor) };
  });

  app.get("/api/v1/tasks/:taskId", async (request) => {
    const session = authenticate(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    return { data: taskboard.readTask(taskId, session.actor) };
  });

  app.get("/api/v1/tasks/:taskId/workspace", async (request) => {
    const session = authenticate(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    return { data: workspace.readTaskWorkspace(taskId, session.actor) };
  });

  app.post("/api/v1/tasks", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const command = CreateTaskCommandSchema.parse(request.body);
    if (!taskCreation) {
      throw new AppError("UPSTREAM_ERROR", 503, "Codex App Server 当前不可用，无法创建任务");
    }
    const result = await taskCreation.create(command, context);
    await reply.code(201).send({ data: result.task, meta: { revision: result.revision } });
  });

  app.patch("/api/v1/tasks/:taskId", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = UpdateTaskCommandSchema.parse(request.body);
    const result = taskboard.updateTask(taskId, command, context);
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.post("/api/v1/tasks/:taskId/move", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = MoveTaskCommandSchema.parse(request.body);
    const result =
      command.targetStatus === "done" || command.targetStatus === "canceled"
        ? await taskLifecycle.wait(
            taskLifecycle.request(
              taskId,
              { expectedVersion: command.expectedVersion, targetStatus: command.targetStatus },
              context,
            ).id,
          )
        : taskboard.moveTask(taskId, command, context);
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.get("/api/v1/tasks/:taskId/lifecycle", async (request) => {
    const current = authenticate(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    return { data: taskLifecycle.readLatest(taskId, current.actor) };
  });

  app.post("/api/v1/tasks/:taskId/lifecycle", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const operation = taskLifecycle.request(
      taskId,
      TaskLifecycleCommandSchema.parse(request.body),
      context,
    );
    await reply.code(202).send({ data: operation });
  });

  app.post("/api/v1/tasks/:taskId/reassign", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = ReassignTaskCommandSchema.parse(request.body);
    const result = taskboard.reassignTask(taskId, command, context);
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.post("/api/v1/tasks/:taskId/archive", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = ArchiveTaskCommandSchema.parse(request.body);
    const result = taskboard.archiveTask(taskId, command, context);
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.post("/api/v1/tasks/:taskId/restore", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = RestoreTaskCommandSchema.parse(request.body);
    const result = taskDeletion.restoreTask(taskId, command, context);
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.delete("/api/v1/tasks/:taskId", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = await taskDeletion.delete(
      taskId,
      DeleteTaskCommandSchema.parse(request.body),
      context,
    );
    return { data: result, meta: { revision: result.revision } };
  });

  app.post("/api/v1/tasks/:taskId/comments", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = workspace.createComment(
      taskId,
      CreateCommentCommandSchema.parse(request.body),
      context,
    );
    await reply.code(201).send({ data: result.data, meta: { revision: result.revision } });
  });

  app.patch("/api/v1/comments/:commentId", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { commentId } = CommentParamsSchema.parse(request.params);
    const result = workspace.updateComment(
      commentId,
      UpdateCommentCommandSchema.parse(request.body),
      context,
    );
    return { data: result.data, meta: { revision: result.revision } };
  });

  app.delete("/api/v1/comments/:commentId", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { commentId } = CommentParamsSchema.parse(request.params);
    const result = workspace.deleteComment(
      commentId,
      DeleteCommentCommandSchema.parse(request.body),
      context,
    );
    return { data: result.data, meta: { revision: result.revision } };
  });

  app.post("/api/v1/tasks/:taskId/relations", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = workspace.createRelation(
      taskId,
      CreateTaskRelationCommandSchema.parse(request.body),
      context,
    );
    await reply.code(201).send({ data: result.data, meta: { revision: result.revision } });
  });

  app.delete("/api/v1/tasks/:taskId/relations/:relationId", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { taskId, relationId } = RelationParamsSchema.parse(request.params);
    const result = workspace.deleteRelation(taskId, relationId, context);
    return { data: result.data, meta: { revision: result.revision } };
  });

  app.post("/api/v1/tasks/:taskId/read", async (request, reply) => {
    const context = mutationContext(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = workspace.markTaskRead(taskId, context);
    await reply.header("X-Event-Revision", String(result.revision)).code(204).send();
  });

  app.post(
    "/api/v1/tasks/:taskId/attachments",
    {
      bodyLimit: config.CODEXBOARD_ATTACHMENT_MAX_BYTES,
      onRequest: (request, _reply, done) => {
        try {
          const context = mutationContext(request, config, identityService);
          const { taskId } = TaskParamsSchema.parse(request.params);
          attachments.authorizeUpload(taskId, context.actor);
          done();
        } catch (error: unknown) {
          done(error as Error);
        }
      },
    },
    async (request, reply) => {
      const context = mutationContext(request, config, identityService);
      const { taskId } = TaskParamsSchema.parse(request.params);
      const filename = decodeFilenameHeader(request.headers["x-filename"]);
      const contentType = AttachmentContentTypeSchema.parse(request.headers["x-content-type"]);
      const pendingComment =
        z.literal("1").optional().parse(request.headers["x-pending-comment"]) === "1";
      const commentHeader = request.headers["x-comment-id"];
      const body = Buffer.isBuffer(request.body) ? request.body : undefined;
      if (!body) throw new AppError("INVALID_REQUEST", 400, "附件请求体必须是二进制内容");
      const result = attachments.upload(
        taskId,
        {
          filename,
          contentType,
          bytes: body,
          pendingComment,
          commentId: typeof commentHeader === "string" ? EntityIdSchema.parse(commentHeader) : null,
        },
        context,
      );
      await reply.code(201).send({ data: result.data, meta: { revision: result.revision } });
    },
  );

  app.get("/api/v1/attachments/:attachmentId", async (request, reply) => {
    const session = authenticate(request, config, identityService);
    const { attachmentId } = AttachmentParamsSchema.parse(request.params);
    const { preview } = AttachmentDownloadQuerySchema.parse(request.query);
    const opened = attachments.open(attachmentId, session.actor);
    const encoded = encodeURIComponent(opened.metadata.filename);
    await reply
      .header("Content-Type", opened.metadata.contentType)
      .header(
        "Content-Disposition",
        `${preview === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .send(opened.bytes);
  });

  app.delete("/api/v1/attachments/:attachmentId", async (request) => {
    const context = mutationContext(request, config, identityService);
    const { attachmentId } = AttachmentParamsSchema.parse(request.params);
    const result = attachments.delete(attachmentId, context);
    return { data: result.data, meta: { revision: result.revision } };
  });
}
