import { z } from "zod";

import {
  EntityIdSchema,
  EntityVersionSchema,
  IsoTimestampSchema,
  RevisionSchema,
} from "./common.js";
import { TaskPrioritySchema, TaskStatusSchema } from "./domain.js";
import { ProjectViewSchema } from "./projects.js";
import { PrincipalSummarySchema, FeishuIdentityRefSchema, IdentityRefSchema } from "./identity.js";

export const TaskTitleSchema = z.string().trim().min(1).max(500);
export const TaskDescriptionSchema = z.string().max(100_000);
export const TaskLabelSchema = z.string().trim().min(1).max(40);
export const ActiveTaskStatusSchema = z.enum(["backlog", "todo", "in_progress", "in_review"]);
export const TaskLabelsSchema = z
  .array(TaskLabelSchema)
  .max(20)
  .refine((labels) => new Set(labels).size === labels.length, "任务标签不能重复");

export const TaskLinkSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine((link) => {
    try {
      const protocol = new URL(link).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "任务链接必须使用 HTTP 或 HTTPS");

export const TaskLinksSchema = z
  .array(TaskLinkSchema)
  .max(20)
  .refine((links) => new Set(links).size === links.length, "任务链接不能重复");

export const InitialTaskRelationsSchema = z
  .object({
    parentTaskId: EntityIdSchema.nullable().default(null),
    childTaskId: EntityIdSchema.nullable().default(null),
    childTaskIds: z.array(EntityIdSchema).optional(),
    relatedTaskIds: z
      .array(EntityIdSchema)
      .refine((taskIds) => new Set(taskIds).size === taskIds.length, "关联任务不能重复")
      .default([]),
  })
  .refine(({ parentTaskId, childTaskId, childTaskIds, relatedTaskIds }) => {
    const targets = [parentTaskId, childTaskId, ...(childTaskIds ?? []), ...relatedTaskIds].filter(
      (taskId): taskId is string => taskId !== null,
    );
    return new Set(targets).size === targets.length;
  }, "父任务、子任务和关联任务不能指向同一任务");

export const TaskRecurrenceRuleSchema = z
  .record(z.string().min(1).max(80), z.json())
  .refine((rule) => Object.keys(rule).length <= 20, "重复规则字段过多")
  .refine((rule) => JSON.stringify(rule).length <= 10_000, "重复规则过大");

const NullableTimestampSchema = IsoTimestampSchema.nullable();

function validDateRange(value: {
  startAt?: string | null | undefined;
  dueAt?: string | null | undefined;
}): boolean {
  if (!value.startAt || !value.dueAt) {
    return true;
  }
  return new Date(value.startAt).getTime() <= new Date(value.dueAt).getTime();
}

export const CreateTaskCommandSchema = z
  .strictObject({
    projectId: EntityIdSchema,
    title: TaskTitleSchema,
    description: TaskDescriptionSchema.default(""),
    status: TaskStatusSchema.default("backlog"),
    priority: TaskPrioritySchema.default("none"),
    labels: TaskLabelsSchema.default([]),
    assigneeIdentity: FeishuIdentityRefSchema.nullable().default(null),
    startAt: NullableTimestampSchema.default(null),
    dueAt: NullableTimestampSchema.default(null),
    recurrence: TaskRecurrenceRuleSchema.nullable().default(null),
    developmentContextId: EntityIdSchema.nullable().default(null),
    links: TaskLinksSchema.default([]),
    initialRelations: InitialTaskRelationsSchema.default({
      parentTaskId: null,
      childTaskId: null,
      relatedTaskIds: [],
    }),
  })
  .refine(validDateRange, { message: "任务截止时间不能早于开始时间" });

export const UpdateTaskCommandSchema = z
  .strictObject({
    expectedVersion: EntityVersionSchema,
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    labels: TaskLabelsSchema.optional(),
    assigneeIdentity: FeishuIdentityRefSchema.nullable().optional(),
    startAt: NullableTimestampSchema.optional(),
    dueAt: NullableTimestampSchema.optional(),
    recurrence: TaskRecurrenceRuleSchema.nullable().optional(),
    developmentContextId: EntityIdSchema.nullable().optional(),
    links: TaskLinksSchema.optional(),
  })
  .refine(
    (command) => Object.keys(command).some((key) => key !== "expectedVersion"),
    "至少需要修改一个任务字段",
  )
  .refine(validDateRange, { message: "任务截止时间不能早于开始时间" });

export const MoveTaskCommandSchema = z
  .object({
    expectedVersion: EntityVersionSchema,
    targetStatus: TaskStatusSchema,
    boardProjectId: EntityIdSchema.optional(),
    beforeTaskId: EntityIdSchema.optional(),
    afterTaskId: EntityIdSchema.optional(),
  })
  .refine(
    (command) =>
      !command.beforeTaskId || !command.afterTaskId || command.beforeTaskId !== command.afterTaskId,
    "前后排序锚点不能是同一任务",
  );

export const ArchiveTaskCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
});

export const RestoreTaskCommandSchema = ArchiveTaskCommandSchema;

export const DeleteTaskCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
});

export const DeleteTaskResultSchema = z.object({
  taskId: EntityIdSchema,
  projectId: EntityIdSchema,
  revision: RevisionSchema.positive(),
});

export const ReassignTaskCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
  targetProjectId: EntityIdSchema,
  mode: z.enum(["single", "origin_group"]),
});

export const TaskPermissionsSchema = z.object({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canExecute: z.boolean(),
  canReassign: z.boolean(),
});

export const TaskViewBaseSchema = z.object({
  id: EntityIdSchema,
  identifier: z.string().min(1),
  projectId: EntityIdSchema,
  projectName: z.string().trim().min(1).max(120),
  originProjectName: z.string().trim().min(1).max(120).nullable(),
  descriptionLocked: z.boolean().optional(),
  developmentContextLocked: z.boolean().optional(),
  codexThreadState: z.enum(["none", "draft", "started"]).default("none"),
  permissions: TaskPermissionsSchema,
  taskNumber: z.number().int().positive(),
  title: TaskTitleSchema,
  description: TaskDescriptionSchema,
  status: TaskStatusSchema,
  blockedFromStatus: ActiveTaskStatusSchema.nullable(),
  priority: TaskPrioritySchema,
  labels: TaskLabelsSchema,
  // Historical service assignments remain readable; write commands accept Feishu only.
  assigneeIdentity: IdentityRefSchema.nullable(),
  assignee: PrincipalSummarySchema.nullable().optional(),
  creatorIdentity: IdentityRefSchema.nullable(),
  startAt: NullableTimestampSchema,
  dueAt: NullableTimestampSchema,
  recurrence: TaskRecurrenceRuleSchema.nullable(),
  developmentContextId: EntityIdSchema.nullable(),
  links: TaskLinksSchema.default([]),
  sortOrder: z.number().finite(),
  version: EntityVersionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  archivedAt: NullableTimestampSchema,
});

export const TaskViewSchema = TaskViewBaseSchema.extend({
  workingDirectory: z.string().min(1).nullable().optional(),
}).superRefine((task, context) => {
  if (task.status === "blocked" && task.blockedFromStatus === null) {
    context.addIssue({
      code: "custom",
      path: ["blockedFromStatus"],
      message: "已阻塞任务必须记录阻塞前状态",
    });
  }
  if (task.status !== "blocked" && task.blockedFromStatus !== null) {
    context.addIssue({
      code: "custom",
      path: ["blockedFromStatus"],
      message: "非阻塞任务不能记录阻塞前状态",
    });
  }
});

export const TaskConflictSummarySchema = TaskViewBaseSchema.pick({
  id: true,
  identifier: true,
  status: true,
  priority: true,
  sortOrder: true,
  version: true,
  updatedAt: true,
  archivedAt: true,
});

export const BoardViewSchema = z.object({
  project: ProjectViewSchema,
  tasks: z.array(TaskViewSchema),
});

export const TaskMutationResultSchema = z.object({
  task: TaskViewSchema,
  revision: RevisionSchema.positive(),
});

export type CreateTaskCommand = z.infer<typeof CreateTaskCommandSchema>;
export type UpdateTaskCommand = z.infer<typeof UpdateTaskCommandSchema>;
export type TaskLink = z.infer<typeof TaskLinkSchema>;
export type TaskLinks = z.infer<typeof TaskLinksSchema>;
export type InitialTaskRelations = z.infer<typeof InitialTaskRelationsSchema>;
export type MoveTaskCommand = z.infer<typeof MoveTaskCommandSchema>;
export type ArchiveTaskCommand = z.infer<typeof ArchiveTaskCommandSchema>;
export type RestoreTaskCommand = z.infer<typeof RestoreTaskCommandSchema>;
export type DeleteTaskCommand = z.infer<typeof DeleteTaskCommandSchema>;
export type DeleteTaskResult = z.infer<typeof DeleteTaskResultSchema>;
export type ReassignTaskCommand = z.infer<typeof ReassignTaskCommandSchema>;
export type TaskPermissions = z.infer<typeof TaskPermissionsSchema>;
export type TaskView = z.infer<typeof TaskViewSchema>;
export type TaskConflictSummary = z.infer<typeof TaskConflictSummarySchema>;
export type BoardView = z.infer<typeof BoardViewSchema>;
export type TaskMutationResult = z.infer<typeof TaskMutationResultSchema>;

export const TaskProgressSchema = z
  .object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .refine((value) => value.completed <= value.total);
