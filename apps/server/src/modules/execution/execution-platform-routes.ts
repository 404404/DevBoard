import {
  CreateConnectionCommandSchema,
  CreateExecutionProfileCommandSchema,
  CreateMilestoneCommandSchema,
  CreateWorkspaceMappingCommandSchema,
  EntityIdSchema,
  ExecutionApprovalDecisionSchema,
  identityKey,
  UpdateConnectionCommandSchema,
  UpdateProjectExecutionProfileCommandSchema,
  UpdateExecutionProfileCommandSchema,
  type PrincipalView,
  type ExecutionApprovalDecision,
} from "@codexboard/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { AppError } from "../../app-error.js";
import {
  sessionCookieNames,
  type IdentityService,
  type SessionContext,
} from "../identity/index.js";
import type { Taskboard } from "../taskboard/index.js";
import type { ExecutionPlatformService } from "./execution-platform-service.js";

const ProjectParamsSchema = z.object({ projectId: EntityIdSchema });
const TaskParamsSchema = z.object({ taskId: EntityIdSchema });
const ConnectionParamsSchema = z.object({ connectionId: EntityIdSchema });
const TrustHostKeyBodySchema = z.object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/) });
const ProfileParamsSchema = z.object({ profileId: EntityIdSchema });
const MappingParamsSchema = z.object({ projectId: EntityIdSchema, mappingId: EntityIdSchema });
const RunParamsSchema = z.object({ runId: EntityIdSchema });
const ApprovalParamsSchema = z.object({ runId: EntityIdSchema, approvalId: EntityIdSchema });
const TestConnectionBodySchema = z.object({ workspace: z.string().trim().min(1).max(4_096).optional() });
const InspectWorkspaceQuerySchema = z.object({ path: z.string().trim().min(1).max(4_096) });
const StartRunBodySchema = z.strictObject({
  executionProfileId: EntityIdSchema.nullable().optional(),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().max(200).nullable().optional(),
  reasoningEffort: z.string().trim().max(80).nullable().optional(),
  mode: z.string().trim().max(80).nullable().optional(),
  permissionMode: z.string().trim().max(120).nullable().optional(),
});

const ContinueRunBodySchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
});

function assertTaskExecution(task: ReturnType<Taskboard["readTask"]>): void {
  if (!task.permissions.canExecute) throw new AppError("FORBIDDEN", 403, "没有该任务执行权限");
}

interface ExecutionPlatformRoutesOptions {
  readonly config: AppConfig;
  readonly identityService: IdentityService;
  readonly taskboard: Taskboard;
  readonly service: ExecutionPlatformService;
}

function authenticate(
  request: FastifyRequest,
  config: AppConfig,
  identityService: IdentityService,
): SessionContext {
  const names = sessionCookieNames(config, request.cookies);
  return identityService.authenticate(request.cookies[names.session]);
}

function authorizeMutation(
  request: FastifyRequest,
  config: AppConfig,
  identityService: IdentityService,
): PrincipalView {
  const names = sessionCookieNames(config, request.cookies);
  const current = identityService.authenticate(request.cookies[names.session]);
  const csrfHeader = request.headers["x-csrf-token"];
  identityService.assertCsrf(
    current,
    typeof csrfHeader === "string" ? csrfHeader : undefined,
    request.cookies[names.csrf],
  );
  return current.actor;
}

function authorizeProject(
  identityService: IdentityService,
  actor: PrincipalView,
  projectId: string,
  action: "read" | "write",
): void {
  identityService.authorizeProject(actor, projectId, action);
}

export function registerExecutionPlatformRoutes(
  app: FastifyInstance,
  options: ExecutionPlatformRoutesOptions,
): void {
  const { config, identityService, taskboard, service } = options;

  app.get("/api/v1/execution/settings", async (request) => {
    const current = authenticate(request, config, identityService);
    identityService.assertBoardAccess(current.actor);
    return { data: await service.readSettings() };
  });

  app.get("/api/v1/execution/connections", async (request) => {
    const current = authenticate(request, config, identityService);
    identityService.assertBoardAccess(current.actor);
    return { data: service.listConnections() };
  });

  app.post("/api/v1/execution/connections", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const result = service.createConnection(CreateConnectionCommandSchema.parse(request.body ?? {}));
    await reply.code(201).send({ data: result });
  });

  app.patch("/api/v1/execution/connections/:connectionId", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    return {
      data: service.updateConnection(
        connectionId,
        UpdateConnectionCommandSchema.parse(request.body ?? {}),
      ),
    };
  });

  app.delete("/api/v1/execution/connections/:connectionId", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    return { data: service.deleteConnection(connectionId) };
  });

  app.post("/api/v1/execution/connections/:connectionId/test", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const body = TestConnectionBodySchema.parse(request.body ?? {});
    return { data: await service.testConnection(connectionId, body.workspace ?? "/") };
  });

  app.get("/api/v1/execution/connections/:connectionId/host-keys", async (request) => {
    const current = authenticate(request, config, identityService);
    identityService.assertBoardAccess(current.actor);
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    return { data: service.listTrustedHostKeys(connectionId) };
  });

  app.post("/api/v1/execution/connections/:connectionId/host-keys/scan", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    return { data: await service.scanHostKeys(connectionId) };
  });

  app.post("/api/v1/execution/connections/:connectionId/host-keys/trust", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const body = TrustHostKeyBodySchema.parse(request.body ?? {});
    return { data: service.trustHostKey(connectionId, body.fingerprint) };
  });

  app.get("/api/v1/execution/connections/:connectionId/workspace", async (request) => {
    const current = authenticate(request, config, identityService);
    identityService.assertBoardAccess(current.actor);
    const { connectionId } = ConnectionParamsSchema.parse(request.params);
    const query = InspectWorkspaceQuerySchema.parse(request.query);
    return { data: await service.inspectWorkspace(connectionId, query.path) };
  });

  app.get("/api/v1/execution/profiles", async (request) => {
    const current = authenticate(request, config, identityService);
    identityService.assertBoardAccess(current.actor);
    return { data: service.listProfiles() };
  });

  app.post("/api/v1/execution/profiles", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const result = await service.createProfile(
      CreateExecutionProfileCommandSchema.parse(request.body ?? {}),
    );
    await reply.code(201).send({ data: result });
  });

  app.patch("/api/v1/execution/profiles/:profileId", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const { profileId } = ProfileParamsSchema.parse(request.params);
    return {
      data: await service.updateProfile(
        profileId,
        UpdateExecutionProfileCommandSchema.parse(request.body ?? {}),
      ),
    };
  });

  app.delete("/api/v1/execution/profiles/:profileId", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    identityService.assertBoardAccess(actor);
    const { profileId } = ProfileParamsSchema.parse(request.params);
    return { data: service.deleteProfile(profileId) };
  });

  app.get("/api/v1/projects/:projectId/execution-profile", async (request) => {
    const current = authenticate(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    authorizeProject(identityService, current.actor, projectId, "read");
    return { data: service.readProjectDefaultProfile(projectId) };
  });

  app.put("/api/v1/projects/:projectId/execution-profile", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    authorizeProject(identityService, actor, projectId, "write");
    const command = UpdateProjectExecutionProfileCommandSchema.parse(request.body ?? {});
    return { data: service.setProjectDefaultProfile(projectId, command.profileId) };
  });

  app.get("/api/v1/projects/:projectId/workspace-mappings", async (request) => {
    const current = authenticate(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    authorizeProject(identityService, current.actor, projectId, "read");
    return { data: service.listMappings(projectId) };
  });

  app.post("/api/v1/projects/:projectId/workspace-mappings", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    authorizeProject(identityService, actor, projectId, "write");
    const command = CreateWorkspaceMappingCommandSchema.parse({
      ...(request.body ?? {}),
      projectId,
    });
    const result = await service.createMapping(command);
    await reply.code(201).send({ data: result });
  });

  app.post("/api/v1/projects/:projectId/workspace-mappings/create", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    authorizeProject(identityService, actor, projectId, "write");
    const command = CreateWorkspaceMappingCommandSchema.parse({
      ...(request.body ?? {}),
      projectId,
    });
    const result = await service.createRemoteWorkspaceMapping(command);
    await reply.code(201).send({ data: result });
  });

  app.delete(
    "/api/v1/projects/:projectId/workspace-mappings/:mappingId",
    async (request) => {
      const actor = authorizeMutation(request, config, identityService);
      const { projectId, mappingId } = MappingParamsSchema.parse(request.params);
      authorizeProject(identityService, actor, projectId, "write");
      return { data: service.deleteMapping(mappingId, projectId) };
    },
  );

  app.get("/api/v1/projects/:projectId/milestones", async (request) => {
    const current = authenticate(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    authorizeProject(identityService, current.actor, projectId, "read");
    return { data: service.listMilestones(projectId) };
  });

  app.post("/api/v1/projects/:projectId/milestones", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    const { projectId } = ProjectParamsSchema.parse(request.params);
    authorizeProject(identityService, actor, projectId, "write");
    const result = service.createMilestone(
      CreateMilestoneCommandSchema.parse({ ...(request.body ?? {}), projectId }),
    );
    await reply.code(201).send({ data: result });
  });

  app.post("/api/v1/tasks/:taskId/runs/start", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    const task = taskboard.readTask(taskId, actor);
    assertTaskExecution(task);
    const body = StartRunBodySchema.parse(request.body ?? {});
    const executionProfileId = service.resolveExecutionProfile(task.projectId, body.executionProfileId);
    const workspace = service.resolveWorkspace(task.projectId, executionProfileId);
    const run = service.createRun({
      taskId,
      executionProfileId,
      workspace,
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
    });
    const started = service.startRun(run.id, body.prompt);
    await reply.code(202).send({ data: started });
  });

  app.post("/api/v1/runs/:runId/continue", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    const { runId } = RunParamsSchema.parse(request.params);
    const run = service.readRun(runId);
    const task = taskboard.readTask(run.taskId, actor);
    assertTaskExecution(task);
    const body = ContinueRunBodySchema.parse(request.body ?? {});
    const continued = service.continueRun(runId, body.prompt);
    await reply.code(202).send({ data: continued });
  });

  app.post("/api/v1/runs/:runId/cancel", async (request, reply) => {
    const actor = authorizeMutation(request, config, identityService);
    const { runId } = RunParamsSchema.parse(request.params);
    const run = service.readRun(runId);
    const task = taskboard.readTask(run.taskId, actor);
    assertTaskExecution(task);
    const canceled = await service.interruptRun(runId);
    await reply.code(202).send({ data: canceled });
  });

  app.get("/api/v1/runs/:runId/approvals", async (request) => {
    const current = authenticate(request, config, identityService);
    const { runId } = RunParamsSchema.parse(request.params);
    const run = service.readRun(runId);
    const task = taskboard.readTask(run.taskId, current.actor);
    assertTaskExecution(task);
    return { data: service.listApprovals(runId) };
  });

  app.post("/api/v1/runs/:runId/approvals/:approvalId/respond", async (request) => {
    const actor = authorizeMutation(request, config, identityService);
    const { runId, approvalId } = ApprovalParamsSchema.parse(request.params);
    const run = service.readRun(runId);
    const task = taskboard.readTask(run.taskId, actor);
    assertTaskExecution(task);
    const approval = service.readApproval(approvalId);
    if (approval.runId !== runId) throw new AppError("NOT_FOUND", 404, "Execution Approval 不存在");
    const decision = ExecutionApprovalDecisionSchema.parse(request.body ?? {}) as ExecutionApprovalDecision;
    return { data: service.resolveApproval(approvalId, decision, identityKey(actor.identity)) };
  });

  app.get("/api/v1/tasks/:taskId/runs", async (request) => {
    const current = authenticate(request, config, identityService);
    const { taskId } = TaskParamsSchema.parse(request.params);
    taskboard.readTask(taskId, current.actor);
    return { data: service.listRuns(taskId) };
  });

  app.get("/api/v1/runs/:runId", async (request) => {
    const current = authenticate(request, config, identityService);
    const { runId } = RunParamsSchema.parse(request.params);
    const run = service.readRun(runId);
    taskboard.readTask(run.taskId, current.actor);
    return { data: run };
  });

}
