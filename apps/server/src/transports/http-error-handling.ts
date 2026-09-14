import { ErrorEnvelopeSchema, type ErrorCode } from "@lark-codex/contracts";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { AppError } from "../app-error.js";

function safeErrorType(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof Error) return "Error";
  return "NonError";
}

function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Readonly<Record<string, unknown>>,
) {
  return ErrorEnvelopeSchema.parse({
    error: {
      code,
      message,
      requestId,
      details,
    },
  });
}

export function registerHttpErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send(errorEnvelope("NOT_FOUND", "请求的资源不存在", request.id));
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error(
          {
            appErrorCode: error.code,
            errorType: safeErrorType(error),
            route: request.routeOptions.url,
            statusCode: error.statusCode,
          },
          "Handled server error",
        );
      }
      const publicMessage = error.statusCode >= 500 ? "服务暂时不可用" : error.message;
      await reply
        .code(error.statusCode)
        .send(
          errorEnvelope(
            error.code,
            publicMessage,
            request.id,
            error.statusCode >= 500 ? undefined : error.details,
          ),
        );
      return;
    }

    if (error instanceof ZodError) {
      await reply.code(400).send(errorEnvelope("INVALID_REQUEST", "请求数据无效", request.id));
      return;
    }

    if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      await reply
        .code(413)
        .send(errorEnvelope("INVALID_REQUEST", "请求体超过允许大小", request.id));
      return;
    }

    request.log.error({ errorType: safeErrorType(error) }, "Unhandled request error");
    await reply.code(500).send(errorEnvelope("INTERNAL_ERROR", "服务暂时不可用", request.id));
  });
}
