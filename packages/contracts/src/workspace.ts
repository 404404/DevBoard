import { z } from "zod";

import {
  EntityIdSchema,
  EntityVersionSchema,
  IsoTimestampSchema,
  RevisionSchema,
} from "./common.js";
import { JobStatusSchema, TaskPrioritySchema } from "./domain.js";
import { PrincipalSummarySchema } from "./identity.js";
import { TaskViewBaseSchema, TaskViewSchema } from "./tasks.js";

export const CommentBodySchema = z.string().trim().min(1).max(100_000);

export const CreateCommentCommandSchema = z
  .object({
    body: z.string().trim().max(100_000),
    attachmentIds: z.array(EntityIdSchema).optional(),
  })
  .refine((command) => command.body.length > 0 || (command.attachmentIds?.length ?? 0) > 0, {
    message: "评论正文和附件不能同时为空",
    path: ["body"],
  });
export const UpdateCommentCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
  body: CommentBodySchema,
});
export const DeleteCommentCommandSchema = z.object({ expectedVersion: EntityVersionSchema });

export const CommentViewSchema = z.object({
  source: z.enum(["user", "codex"]).optional(),
  executedAt: z.string().nullable().optional(),
  codexThreadId: z.string().nullable().optional(),
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  author: PrincipalSummarySchema.nullable(),
  body: z.string(),
  version: EntityVersionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  deletedAt: IsoTimestampSchema.nullable(),
});

export const AttachmentFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..", {
    message: "附件名称不能包含路径",
  });

export const AttachmentContentTypeSchema = z.string().trim().min(1).max(255);

export const AttachmentViewSchema = z.object({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  commentId: EntityIdSchema.nullable(),
  uploader: PrincipalSummarySchema.nullable(),
  filename: AttachmentFilenameSchema,
  contentType: AttachmentContentTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: IsoTimestampSchema,
  downloadUrl: z.string().regex(/^\/api\/v1\/(?:local\/)?attachments\/[0-9a-f-]{36}$/),
});

export const CreateTaskRelationCommandSchema = z.object({
  relationType: z.enum(["parent", "child", "blocks", "blocked_by", "related"]),
  targetTaskId: EntityIdSchema,
});

export const TaskRelationViewSchema = z.object({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  targetTaskId: EntityIdSchema,
  relationType: z.enum(["parent", "child", "blocks", "blocked_by", "related"]),
  targetIdentifier: z.string().min(1),
  targetTitle: z.string().min(1),
  createdBy: PrincipalSummarySchema.nullable(),
  createdAt: IsoTimestampSchema,
});

export const ActivityViewSchema = z.object({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  actor: PrincipalSummarySchema.nullable(),
  kind: z.string().min(1).max(100),
  changes: z.record(z.string(), z.json()),
  createdAt: IsoTimestampSchema,
});

export const ExecutionSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  latest: z
    .object({
      id: EntityIdSchema,
      status: JobStatusSchema,
      updatedAt: IsoTimestampSchema,
      errorSummary: z.string().max(2_000).nullable(),
    })
    .nullable(),
});

export const TaskWorkspaceViewSchema = z.object({
  task: TaskViewSchema,
  comments: z.array(CommentViewSchema),
  attachments: z.array(AttachmentViewSchema),
  relations: z.array(TaskRelationViewSchema),
  activities: z.array(ActivityViewSchema),
  executionSummary: ExecutionSummarySchema,
});

export const DashboardTaskSchema = TaskViewBaseSchema.pick({
  id: true,
  identifier: true,
  title: true,
  status: true,
  priority: true,
  dueAt: true,
  assigneeIdentity: true,
  version: true,
  updatedAt: true,
});

export const DashboardViewSchema = z.object({
  projectId: EntityIdSchema,
  totalTasks: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(),
  completionPercent: z.number().min(0).max(100),
  priorityCounts: z.record(TaskPrioritySchema, z.number().int().nonnegative()),
  blockedOrUnreadCount: z.number().int().nonnegative(),
  runningConversationCount: z.number().int().nonnegative(),
  blockedOrUnreadTasks: z.array(DashboardTaskSchema),
  dueSoonTasks: z.array(DashboardTaskSchema),
});

export function WorkspaceMutationResultSchema<Data>(data: z.ZodType<Data>) {
  return z.object({ data, revision: RevisionSchema.positive() });
}

export type CreateCommentCommand = z.infer<typeof CreateCommentCommandSchema>;
export type UpdateCommentCommand = z.infer<typeof UpdateCommentCommandSchema>;
export type DeleteCommentCommand = z.infer<typeof DeleteCommentCommandSchema>;
export type CommentView = z.infer<typeof CommentViewSchema>;
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;
export type CreateTaskRelationCommand = z.infer<typeof CreateTaskRelationCommandSchema>;
export type TaskRelationView = z.infer<typeof TaskRelationViewSchema>;
export type ActivityView = z.infer<typeof ActivityViewSchema>;
export type TaskWorkspaceView = z.infer<typeof TaskWorkspaceViewSchema>;
export type DashboardView = z.infer<typeof DashboardViewSchema>;
export type WorkspaceMutationResult<Data> = { readonly data: Data; readonly revision: number };
