import { z } from "zod";

import { EntityIdSchema, IsoTimestampSchema } from "./common.js";
import { IdentityRefSchema } from "./identity.js";
import { JobKindSchema, JobStatusSchema } from "./domain.js";

export const SubmitExecutionCommandSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000).optional(),
});

export const InteractionDecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accept") }),
  z.object({ type: z.literal("decline") }),
  z.object({ type: z.literal("cancel") }),
  z.object({
    type: z.literal("input"),
    answers: z.record(z.string().min(1).max(200), z.array(z.string().max(10_000)).min(1)),
  }),
]);

export const InteractionViewSchema = z.object({
  id: EntityIdSchema,
  jobId: EntityIdSchema,
  serverRequestId: z.string().min(1).max(200),
  kind: z.enum(["command_approval", "file_change_approval", "user_input", "other"]),
  status: z.enum(["pending", "responded", "expired", "canceled"]),
  requestMethod: z.string().min(1).max(200),
  safeRequest: z.record(z.string(), z.json()),
  decision: InteractionDecisionSchema.nullable(),
  decidedBy: IdentityRefSchema.nullable(),
  createdAt: IsoTimestampSchema,
  decidedAt: IsoTimestampSchema.nullable(),
});

export const JobWorkContextSchema = z
  .record(z.string().min(1).max(100), z.json())
  .refine((context) => JSON.stringify(context).length <= 200_000, "执行上下文过大");

export const JobEventViewSchema = z.object({
  id: EntityIdSchema,
  seq: z.number().int().positive(),
  kind: z.string().trim().min(1).max(100),
  summary: z.string().max(2_000),
  safePayload: z.record(z.string(), z.json()),
  createdAt: IsoTimestampSchema,
});

export const JobViewSchema = z.object({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  taskThreadId: EntityIdSchema.nullable(),
  targetJobId: EntityIdSchema.nullable(),
  kind: JobKindSchema,
  status: JobStatusSchema,
  executionKey: z.string().min(1).max(4_096),
  requestedBy: IdentityRefSchema.nullable(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  leaseOwner: z.string().min(1).max(200).nullable(),
  leaseExpiresAt: IsoTimestampSchema.nullable(),
  errorCode: z.string().min(1).max(100).nullable(),
  errorSummary: z.string().max(2_000).nullable(),
  workContext: JobWorkContextSchema,
  recoveryCheckpoint: z.record(z.string(), z.json()).nullable(),
  queuedAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  cancelRequestedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
  updatedAt: IsoTimestampSchema,
  events: z.array(JobEventViewSchema),
});

export type JobWorkContext = z.infer<typeof JobWorkContextSchema>;
export type JobEventView = z.infer<typeof JobEventViewSchema>;
export type JobView = z.infer<typeof JobViewSchema>;
export type SubmitExecutionCommand = z.infer<typeof SubmitExecutionCommandSchema>;
export type InteractionDecision = z.infer<typeof InteractionDecisionSchema>;
export type InteractionView = z.infer<typeof InteractionViewSchema>;
