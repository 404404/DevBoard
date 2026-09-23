import { z } from "zod";

export const ComponentHealthSchema = z.enum(["ok", "degraded", "unavailable"]);

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.enum(["codexboard-server", "codexboard-server"]),
  version: z.string().min(1),
  timestamp: z.string().datetime(),
  checks: z.object({
    http: ComponentHealthSchema,
    sqlite: ComponentHealthSchema,
    migrations: ComponentHealthSchema,
    events: ComponentHealthSchema,
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
