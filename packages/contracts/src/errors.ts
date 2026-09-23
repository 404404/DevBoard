import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "CONFIG_INVALID",
  "CSRF_INVALID",
  "DATABASE_ERROR",
  "DUPLICATE_REQUEST",
  "FORBIDDEN",
  "INTERNAL_ERROR",
  "INVALID_REQUEST",
  "MIGRATION_FAILED",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "UPSTREAM_ERROR",
  "VERSION_CONFLICT",
  "CONNECTION_OFFLINE",
  "SSH_AUTH_FAILED",
  "HOST_KEY_FAILED",
  "HOST_KEY_UNTRUSTED",
  "HOST_KEY_CHANGED",
  "SSH_KEY_PASSPHRASE_REQUIRED",
  "SSH_AGENT_UNAVAILABLE",
  "SSH_IDENTITY_NOT_FOUND",
  "SSH_IDENTITY_INVALID",
  "SSH_IDENTITY_PERMISSIONS",
  "PROVIDER_NOT_INSTALLED",
  "PROVIDER_AUTH_REQUIRED",
  "PROVIDER_PROTOCOL_ERROR",
  "WORKSPACE_NOT_FOUND",
  "MODEL_UNAVAILABLE",
  "RUN_INTERRUPTED",
  "RUN_TIMEOUT",
  "PROVIDER_DISCONNECTED",
]);

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
