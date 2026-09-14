import type { ErrorCode } from "@lark-taskboard/contracts";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    options?: ErrorOptions & { details?: Readonly<Record<string, unknown>> },
  ) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = options?.details;
  }
}
