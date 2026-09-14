import { ErrorEnvelopeSchema } from "@lark-taskboard/contracts";
import { z } from "zod";
import { ApiError } from "./api";

const CliAuthRequestSchema = z.object({
  requestId: z.string(),
  label: z.string(),
  verificationCode: z.string(),
  status: z.enum(["pending", "approved", "claimed", "expired"]),
  expiresAt: z.iso.datetime(),
});
async function requestCliAuth(requestId: string, csrfToken?: string) {
  const path = `/api/v1/auth/cli/requests/${encodeURIComponent(requestId)}`;
  const response = await fetch(csrfToken === undefined ? path : `${path}/approve`, {
    method: csrfToken === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers:
      csrfToken === undefined
        ? { Accept: "application/json" }
        : {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
    ...(csrfToken === undefined ? {} : { body: "{}" }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ErrorEnvelopeSchema.safeParse(payload);
    throw new ApiError(
      response.status,
      error.success ? error.data.error.code : "INVALID_REQUEST",
      error.success ? error.data.error.message : "无法读取或授权 CLI 登录请求",
    );
  }
  return z.object({ data: CliAuthRequestSchema }).parse(payload).data;
}
export function readCliRequest(requestId: string) {
  return requestCliAuth(requestId);
}
export function approveCliRequest(requestId: string, csrfToken: string) {
  return requestCliAuth(requestId, csrfToken);
}
