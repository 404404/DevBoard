import { z } from "zod";

export const ActorRoleSchema = z.enum(["admin", "member"]);
export const ProjectMemberRoleSchema = z.enum(["owner", "editor", "executor", "viewer"]);

export const TaskStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
]);

export const TaskPrioritySchema = z.enum(["none", "urgent", "high", "medium", "low"]);
export const TaskRelationTypeSchema = z.enum(["parent", "blocks", "related"]);

export const JobKindSchema = z.enum(["start", "continue", "cancel"]);
export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "canceling",
  "succeeded",
  "failed",
  "failed_recoverable",
  "canceled",
]);

export const InteractionKindSchema = z.enum([
  "command_approval",
  "file_change_approval",
  "user_input",
  "other",
]);
export const InteractionStatusSchema = z.enum(["pending", "responded", "expired", "canceled"]);

export type ActorRole = z.infer<typeof ActorRoleSchema>;
export type ProjectMemberRole = z.infer<typeof ProjectMemberRoleSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type TaskRelationType = z.infer<typeof TaskRelationTypeSchema>;
export type JobKind = z.infer<typeof JobKindSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
