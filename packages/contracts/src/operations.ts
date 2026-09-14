import { z } from "zod";

import { ComponentHealthSchema } from "./health.js";

export const ComponentCheckSchema = z
  .object({
    status: ComponentHealthSchema,
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export const RequestMetricsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict();

export const QueueMetricsSchema = z
  .object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    waitingApproval: z.number().int().nonnegative(),
    waitingInput: z.number().int().nonnegative(),
    canceling: z.number().int().nonnegative(),
    failedRecoverable: z.number().int().nonnegative(),
  })
  .strict();

export const LocalOperationsSnapshotSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    timestamp: z.string().datetime(),
    checks: z
      .object({
        http: ComponentCheckSchema,
        sqlite: ComponentCheckSchema,
        queue: ComponentCheckSchema,
        connector: ComponentCheckSchema,
        appServer: ComponentCheckSchema,
      })
      .strict(),
    metrics: z
      .object({
        requests: RequestMetricsSchema,
        queue: QueueMetricsSchema,
      })
      .strict(),
  })
  .strict();

export const BackupFileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const BackupDatabaseFileSchema = BackupFileSchema.extend({
  path: z.literal("taskboard.sqlite"),
});

export const BackupManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    createdAt: z.string().datetime(),
    schemaVersion: z.number().int().positive(),
    database: BackupDatabaseFileSchema,
    attachments: z.array(BackupFileSchema),
  })
  .strict();

export type ComponentCheck = z.infer<typeof ComponentCheckSchema>;
export type LocalOperationsSnapshot = z.infer<typeof LocalOperationsSnapshotSchema>;
export type QueueMetrics = z.infer<typeof QueueMetricsSchema>;
export type RequestMetricsView = z.infer<typeof RequestMetricsSchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
