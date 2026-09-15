import {
  GitManagementViewSchema,
  type CreateGitResourceCommand,
  type DeleteGitResourceCommand,
} from "@codexboard/contracts";
import { createUuid } from "./random-id";
import {
  AuthBootstrapSchema,
  BoardViewSchema,
  CommentViewSchema,
  DashboardViewSchema,
  DeleteTaskResultSchema,
  ErrorEnvelopeSchema,
  InteractionDecisionSchema,
  InteractionViewSchema,
  JobViewSchema,
  GlobalLabelListViewSchema,
  GlobalLabelViewSchema,
  ProjectViewSchema,
  ProjectTaskCreationOptionsViewSchema,
  SessionViewSchema,
  TaskViewSchema,
  TaskRelationViewSchema,
  TaskWorkspaceViewSchema,
  type AuthBootstrap,
  type UserIdentityRef,
  type BoardView,
  type CommentView,
  type DashboardView,
  type DeleteTaskResult,
  type InitialTaskRelations,
  type InteractionDecision,
  type InteractionView,
  type JobView,
  type GlobalLabelView,
  type ProjectTaskCreationOptionsView,
  type SessionView,
  type TaskPriority,
  type TaskRelationView,
  type TaskStatus,
  type TaskView,
  type TaskWorkspaceView,
  AttachmentViewSchema,
  type AttachmentView,
  TaskLifecycleViewSchema,
  type TaskLifecycleView,
  type TaskLifecycleCommand,
} from "@codexboard/contracts";
import { z } from "zod";

const ProjectListResponseSchema = z.object({ data: z.array(ProjectViewSchema) });
const BoardResponseSchema = z.object({ data: BoardViewSchema });
const ProjectTaskCreationOptionsResponseSchema = z.object({
  data: ProjectTaskCreationOptionsViewSchema,
});
const TaskResponseSchema = z.object({ data: TaskViewSchema });
const TaskMutationResponseSchema = z.object({
  data: TaskViewSchema,
  meta: z.object({ revision: z.number().int().positive() }),
});
const DeleteTaskResponseSchema = z.object({
  data: DeleteTaskResultSchema,
  meta: z.object({ revision: z.number().int().positive() }),
});
const SessionResponseSchema = z.object({ data: SessionViewSchema });
const AuthBootstrapResponseSchema = z.object({ data: AuthBootstrapSchema });
const JobResponseSchema = z.object({ data: JobViewSchema });
const JobListResponseSchema = z.object({ data: z.array(JobViewSchema) });
const InteractionResponseSchema = z.object({ data: InteractionViewSchema });
const InteractionListResponseSchema = z.object({ data: z.array(InteractionViewSchema) });
const CancelJobResponseSchema = z.object({
  data: z.object({ target: JobViewSchema, cancel: JobViewSchema }),
});
const DashboardResponseSchema = z.object({ data: DashboardViewSchema });
const TaskWorkspaceResponseSchema = z.object({ data: TaskWorkspaceViewSchema });
const CommentMutationResponseSchema = z.object({
  data: CommentViewSchema,
  meta: z.object({ revision: z.number().int().positive() }),
});
const AttachmentMutationResponseSchema = z.object({
  data: AttachmentViewSchema,
  meta: z.object({ revision: z.number().int().positive() }),
});
const RelationMutationResponseSchema = z.object({
  data: TaskRelationViewSchema,
  meta: z.object({ revision: z.number().int().positive() }),
});
const DeleteRelationResponseSchema = z.object({
  data: z.object({ id: z.uuid() }),
  meta: z.object({ revision: z.number().int().positive() }),
});
const GlobalLabelListResponseSchema = z.object({ data: GlobalLabelListViewSchema });
const GlobalLabelMutationResponseSchema = z.object({
  data: GlobalLabelViewSchema,
  meta: z.object({ revision: z.number().int().positive() }),
});
const GlobalLabelOrderResponseSchema = z.object({
  data: GlobalLabelListViewSchema,
  meta: z.object({ revision: z.number().int().positive() }),
});
const DeleteGlobalLabelResponseSchema = z.object({
  data: z.object({ labelId: z.uuid() }),
  meta: z.object({ revision: z.number().int().positive() }),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest<Output>(
  path: string,
  schema: z.ZodType<Output>,
  init: RequestInit = {},
): Promise<Output> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const raw: unknown = await response.json().catch(() => null);
    const envelope = ErrorEnvelopeSchema.safeParse(raw);
    if (envelope.success) {
      throw new ApiError(
        response.status,
        envelope.data.error.code,
        envelope.data.error.message,
        envelope.data.error.details,
      );
    }
    throw new ApiError(response.status, "INTERNAL_ERROR", `请求失败（${response.status}）`);
  }

  if (response.status === 204) {
    return schema.parse(undefined);
  }
  const payload: unknown = await response.json();
  return schema.parse(payload);
}

export function mutationHeaders(csrfToken: string, idempotencyKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": idempotencyKey,
  };
}

export async function readAuthBootstrap(): Promise<AuthBootstrap> {
  return (await apiRequest("/api/v1/auth/config", AuthBootstrapResponseSchema)).data;
}

export async function readSession(): Promise<SessionView> {
  return (await apiRequest("/api/v1/session", SessionResponseSchema)).data;
}

export async function loginWeb(username: string, password: string): Promise<SessionView> {
  const result = await apiRequest("/api/v1/auth/web/login", SessionResponseSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return result.data;
}

export async function loginDevelopment(): Promise<SessionView> {
  return (
    await apiRequest("/api/v1/auth/development", SessionResponseSchema, {
      method: "POST",
    })
  ).data;
}

export async function loginFeishu(code: string): Promise<SessionView> {
  return (
    await apiRequest("/api/v1/auth/feishu/exchange", SessionResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
  ).data;
}

export async function logout(csrfToken: string): Promise<void> {
  await apiRequest("/api/v1/session/logout", z.undefined(), {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
}

export async function listProjects() {
  return (await apiRequest("/api/v1/projects", ProjectListResponseSchema)).data;
}

export async function readBoard(projectId: string): Promise<BoardView> {
  return (
    await apiRequest(`/api/v1/projects/${encodeURIComponent(projectId)}/board`, BoardResponseSchema)
  ).data;
}

export async function readTaskCreationOptions(
  projectId: string,
): Promise<ProjectTaskCreationOptionsView> {
  return (
    await apiRequest(
      `/api/v1/projects/${encodeURIComponent(projectId)}/task-creation-options`,
      ProjectTaskCreationOptionsResponseSchema,
    )
  ).data;
}

export async function listGlobalLabels(): Promise<readonly GlobalLabelView[]> {
  return (await apiRequest("/api/v1/labels", GlobalLabelListResponseSchema)).data.labels;
}

export async function createGlobalLabel(name: string, csrfToken: string): Promise<GlobalLabelView> {
  return (
    await apiRequest("/api/v1/labels", GlobalLabelMutationResponseSchema, {
      method: "POST",
      headers: mutationHeaders(csrfToken, newIdempotencyKey()),
      body: JSON.stringify({ name }),
    })
  ).data;
}

export async function updateGlobalLabel(
  labelId: string,
  expectedVersion: number,
  name: string,
  csrfToken: string,
): Promise<GlobalLabelView> {
  return (
    await apiRequest(
      `/api/v1/labels/${encodeURIComponent(labelId)}`,
      GlobalLabelMutationResponseSchema,
      {
        method: "PATCH",
        headers: mutationHeaders(csrfToken, newIdempotencyKey()),
        body: JSON.stringify({ expectedVersion, name }),
      },
    )
  ).data;
}

export async function deleteGlobalLabel(
  labelId: string,
  expectedVersion: number,
  csrfToken: string,
): Promise<string> {
  return (
    await apiRequest(
      `/api/v1/labels/${encodeURIComponent(labelId)}`,
      DeleteGlobalLabelResponseSchema,
      {
        method: "DELETE",
        headers: mutationHeaders(csrfToken, newIdempotencyKey()),
        body: JSON.stringify({ expectedVersion }),
      },
    )
  ).data.labelId;
}

export async function reorderGlobalLabels(
  labelIds: readonly string[],
  csrfToken: string,
): Promise<readonly GlobalLabelView[]> {
  return (
    await apiRequest("/api/v1/labels/order", GlobalLabelOrderResponseSchema, {
      method: "PUT",
      headers: mutationHeaders(csrfToken, newIdempotencyKey()),
      body: JSON.stringify({ labelIds }),
    })
  ).data.labels;
}

export async function readTask(taskId: string): Promise<TaskView> {
  return (await apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`, TaskResponseSchema)).data;
}

export async function readDashboard(projectId: string): Promise<DashboardView> {
  return (
    await apiRequest(
      `/api/v1/projects/${encodeURIComponent(projectId)}/dashboard`,
      DashboardResponseSchema,
    )
  ).data;
}

export async function readTaskWorkspace(taskId: string): Promise<TaskWorkspaceView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/workspace`,
      TaskWorkspaceResponseSchema,
    )
  ).data;
}

export async function markTaskRead(taskId: string, csrfToken: string): Promise<void> {
  await apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/read`, z.undefined(), {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": newIdempotencyKey() },
  });
}

function newIdempotencyKey(): string {
  return createUuid();
}

export async function createComment(
  taskId: string,
  body: string,
  csrfToken: string,
  attachmentIds: string[] = [],
  idempotencyKey: string = newIdempotencyKey(),
): Promise<CommentView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/comments`,
      CommentMutationResponseSchema,
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, idempotencyKey),
        body: JSON.stringify({ body, attachmentIds }),
      },
    )
  ).data;
}

export async function updateComment(
  commentId: string,
  expectedVersion: number,
  body: string,
  csrfToken: string,
): Promise<CommentView> {
  return (
    await apiRequest(
      `/api/v1/comments/${encodeURIComponent(commentId)}`,
      CommentMutationResponseSchema,
      {
        method: "PATCH",
        headers: mutationHeaders(csrfToken, newIdempotencyKey()),
        body: JSON.stringify({ expectedVersion, body }),
      },
    )
  ).data;
}

export async function deleteComment(
  commentId: string,
  expectedVersion: number,
  csrfToken: string,
): Promise<CommentView> {
  return (
    await apiRequest(
      `/api/v1/comments/${encodeURIComponent(commentId)}`,
      CommentMutationResponseSchema,
      {
        method: "DELETE",
        headers: mutationHeaders(csrfToken, newIdempotencyKey()),
        body: JSON.stringify({ expectedVersion }),
      },
    )
  ).data;
}

export async function uploadAttachment(
  taskId: string,
  file: File,
  csrfToken: string,
  idempotencyKey: string = newIdempotencyKey(),
  pendingComment = false,
): Promise<AttachmentView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/attachments`,
      AttachmentMutationResponseSchema,
      {
        method: "POST",
        headers: {
          ...(pendingComment ? { "X-Pending-Comment": "1" } : {}),
          "Content-Type": "application/octet-stream",
          "X-Content-Type": file.type || "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: file,
      },
    )
  ).data;
}

export async function createRelation(
  taskId: string,
  relationType: TaskRelationView["relationType"],
  targetTaskId: string,
  csrfToken: string,
): Promise<TaskRelationView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/relations`,
      RelationMutationResponseSchema,
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, newIdempotencyKey()),
        body: JSON.stringify({ relationType, targetTaskId }),
      },
    )
  ).data;
}

export async function deleteRelation(
  taskId: string,
  relationId: string,
  csrfToken: string,
): Promise<string> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/relations/${encodeURIComponent(relationId)}`,
      DeleteRelationResponseSchema,
      { method: "DELETE", headers: mutationHeaders(csrfToken, newIdempotencyKey()), body: "{}" },
    )
  ).data.id;
}

export async function createTask(
  input: {
    projectId: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    labels: string[];
    assigneeIdentity: UserIdentityRef | null;
    developmentContextId: string | null;
    links: string[];
    initialRelations: InitialTaskRelations;
  },
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskView> {
  return (
    await apiRequest("/api/v1/tasks", TaskMutationResponseSchema, {
      method: "POST",
      headers: mutationHeaders(csrfToken, idempotencyKey),
      body: JSON.stringify(input),
    })
  ).data;
}

export async function updateTask(
  taskId: string,
  input: {
    expectedVersion: number;
    title?: string;
    description?: string;
    priority?: TaskPriority;
    assigneeIdentity?: UserIdentityRef | null;
    labels?: string[];
    links?: string[];
    startAt?: string | null;
    dueAt?: string | null;
  },
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskView> {
  return (
    await apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`, TaskMutationResponseSchema, {
      method: "PATCH",
      headers: mutationHeaders(csrfToken, idempotencyKey),
      body: JSON.stringify(input),
    })
  ).data;
}

export async function moveTask(
  taskId: string,
  input: {
    expectedVersion: number;
    targetStatus: TaskStatus;
    boardProjectId?: string;
    beforeTaskId?: string;
    afterTaskId?: string;
  },
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/move`,
      TaskMutationResponseSchema,
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, idempotencyKey),
        body: JSON.stringify(input),
      },
    )
  ).data;
}

export async function deleteTask(
  taskId: string,
  expectedVersion: number,
  csrfToken: string,
  idempotencyKey: string,
): Promise<DeleteTaskResult> {
  return (
    await apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`, DeleteTaskResponseSchema, {
      method: "DELETE",
      headers: mutationHeaders(csrfToken, idempotencyKey),
      body: JSON.stringify({ expectedVersion }),
    })
  ).data;
}

export async function restoreTask(
  taskId: string,
  expectedVersion: number,
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/restore`,
      TaskMutationResponseSchema,
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, idempotencyKey),
        body: JSON.stringify({ expectedVersion }),
      },
    )
  ).data;
}

export async function reassignTask(
  taskId: string,
  input: {
    expectedVersion: number;
    targetProjectId: string;
    mode: "single" | "origin_group";
  },
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/reassign`,
      TaskMutationResponseSchema,
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, idempotencyKey),
        body: JSON.stringify(input),
      },
    )
  ).data;
}

export async function listTaskJobs(taskId: string): Promise<readonly JobView[]> {
  return (
    await apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/jobs`, JobListResponseSchema)
  ).data;
}

export async function readTaskLifecycle(taskId: string): Promise<TaskLifecycleView | null> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/lifecycle`,
      z.object({ data: TaskLifecycleViewSchema.nullable() }),
    )
  ).data;
}

export async function requestTaskLifecycle(
  taskId: string,
  command: TaskLifecycleCommand,
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskLifecycleView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/lifecycle`,
      z.object({ data: TaskLifecycleViewSchema }),
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, idempotencyKey),
        body: JSON.stringify(command),
      },
    )
  ).data;
}

export async function submitTaskJob(
  taskId: string,
  kind: "start" | "continue",
  csrfToken: string,
  idempotencyKey: string,
): Promise<JobView> {
  return (
    await apiRequest(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/jobs/${kind}`,
      JobResponseSchema,
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, idempotencyKey),
        body: JSON.stringify({}),
      },
    )
  ).data;
}

export async function cancelJob(
  jobId: string,
  csrfToken: string,
  idempotencyKey: string,
): Promise<JobView> {
  return (
    await apiRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, CancelJobResponseSchema, {
      method: "POST",
      headers: mutationHeaders(csrfToken, idempotencyKey),
      body: JSON.stringify({}),
    })
  ).data.target;
}

export async function listJobInteractions(jobId: string): Promise<readonly InteractionView[]> {
  return (
    await apiRequest(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/interactions`,
      InteractionListResponseSchema,
    )
  ).data;
}

export async function respondToInteraction(
  interactionId: string,
  decision: InteractionDecision,
  csrfToken: string,
  idempotencyKey: string,
): Promise<InteractionView> {
  const validDecision = InteractionDecisionSchema.parse(decision);
  return (
    await apiRequest(
      `/api/v1/interactions/${encodeURIComponent(interactionId)}/respond`,
      InteractionResponseSchema,
      {
        method: "POST",
        headers: mutationHeaders(csrfToken, idempotencyKey),
        body: JSON.stringify(validDecision),
      },
    )
  ).data;
}

export async function deleteAttachment(
  attachmentId: string,
  csrfToken: string,
): Promise<AttachmentView> {
  return (
    await apiRequest(
      `/api/v1/attachments/${encodeURIComponent(attachmentId)}`,
      AttachmentMutationResponseSchema,
      {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": newIdempotencyKey() },
      },
    )
  ).data;
}

export async function readGitManagement(projectId: string) {
  return (
    await apiRequest(
      `/api/v1/projects/${projectId}/git`,
      z.object({ data: GitManagementViewSchema }),
    )
  ).data;
}
export async function createGitResource(
  projectId: string,
  command: CreateGitResourceCommand,
  csrfToken: string,
) {
  await apiRequest(
    `/api/v1/projects/${projectId}/git`,
    z.object({ data: z.object({ ok: z.literal(true) }) }),
    {
      method: "POST",
      headers: mutationHeaders(csrfToken, createUuid()),
      body: JSON.stringify(command),
    },
  );
}
export async function deleteGitResource(
  projectId: string,
  command: DeleteGitResourceCommand,
  csrfToken: string,
) {
  await apiRequest(
    `/api/v1/projects/${projectId}/git`,
    z.object({ data: z.object({ ok: z.literal(true) }) }),
    {
      method: "DELETE",
      headers: mutationHeaders(csrfToken, createUuid()),
      body: JSON.stringify(command),
    },
  );
}
