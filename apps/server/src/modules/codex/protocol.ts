import { z } from "zod";

export const CodexRequestIdSchema = z.union([z.string().min(1), z.number().int()]);

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: CodexRequestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: CodexRequestIdSchema,
  result: z.unknown(),
});

const JsonRpcFailureSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: CodexRequestIdSchema,
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});

export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessSchema,
  JsonRpcFailureSchema,
]);

export type CodexRequestId = z.infer<typeof CodexRequestIdSchema>;
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

export const SUPPORTED_CODEX_CLIENT_METHODS = [
  "initialize",
  "fs/createDirectory",
  "command/exec",
  "thread/start",
  "thread/name/set",
  "thread/archive",
  "thread/resume",
  "thread/unsubscribe",
  "thread/read",
  "thread/list",
  "model/list",
  "account/rateLimits/read",
  "turn/start",
  "turn/interrupt",
] as const;

export const SUPPORTED_CODEX_SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
] as const;

export type SupportedCodexServerRequestMethod =
  (typeof SUPPORTED_CODEX_SERVER_REQUEST_METHODS)[number];

export function isSupportedServerRequestMethod(
  method: string,
): method is SupportedCodexServerRequestMethod {
  return (SUPPORTED_CODEX_SERVER_REQUEST_METHODS as readonly string[]).includes(method);
}

export interface CodexNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface CodexServerRequest {
  readonly id: CodexRequestId;
  readonly method: SupportedCodexServerRequestMethod;
  readonly params: unknown;
  respond(result: unknown): Promise<void>;
  fail(code: number, message: string, data?: unknown): Promise<void>;
}

export interface CodexTransport {
  readonly description: string;
  connect(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
}
