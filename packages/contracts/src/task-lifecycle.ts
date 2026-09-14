import { z } from "zod";
import { EntityIdSchema, IsoTimestampSchema } from "./common.js";

export const TaskLifecycleCommandSchema = z.object({
  expectedVersion: z.number().int().positive(),
  targetStatus: z.enum(["done", "canceled"]),
});

export const TaskLifecycleViewSchema = z.object({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  targetStatus: z.enum(["done", "canceled"]),
  status: z.enum(["pending", "running", "failed", "succeeded", "abandoned"]),
  phase: z.enum(["checking", "canceling", "committing", "cleaning", "completed"]),
  errorSummary: z.string().nullable(),
  commitSha: z.string().nullable(),
  archiveRef: z.string().nullable(),
  notes: z.array(z.string()),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type TaskLifecycleCommand = z.infer<typeof TaskLifecycleCommandSchema>;
export type TaskLifecycleView = z.infer<typeof TaskLifecycleViewSchema>;
