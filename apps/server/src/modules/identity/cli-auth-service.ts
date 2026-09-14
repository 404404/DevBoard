import { AppError } from "../../app-error.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FeishuIdentityRefSchema, type FeishuIdentityRef } from "@lark-codex/contracts";

export class CliAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 401,
  ) {
    super(message);
  }
}
interface Challenge {
  requestId: string;
  label: string;
  verificationCode: string;
  secretHash: Buffer;
  expires: number;
  status: "pending" | "approved" | "claimed";
  identity?: FeishuIdentityRef;
}
export interface CliAuthServiceOptions {
  now?: () => number;
  randomToken?: () => string;
  challengeTtlMs?: number;
  sessionTtlMs?: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest();

/** Ephemeral independent CLI credentials: restarting the process invalidates all of them. */
export class CliAuthService {
  private readonly challenges = new Map<string, Challenge>();
  private readonly sessions = new Map<string, { identity: FeishuIdentityRef; expires: number }>();
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly challengeTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(options: CliAuthServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.challengeTtlMs = options.challengeTtlMs ?? 600_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 28_800_000;
  }

  create(label: string) {
    if (typeof label !== "string" || !label.trim() || label.length > 120)
      throw new CliAuthError("CLI_AUTH_INVALID_LABEL", "CLI 名称必须为 1–120 个字符", 400);
    // Bound retained expired entries without extending any lifetime.
    for (const [id, value] of this.challenges)
      if (value.expires + this.challengeTtlMs <= this.now()) this.challenges.delete(id);
    for (const [key, value] of this.sessions)
      if (value.expires <= this.now()) this.sessions.delete(key);
    const requestId = this.randomToken();
    const claimSecret = this.randomToken();
    const verificationCode = hash(this.randomToken()).toString("hex").slice(0, 8).toUpperCase();
    const expires = this.now() + this.challengeTtlMs;
    this.challenges.set(requestId, {
      requestId,
      label: label.trim(),
      verificationCode,
      secretHash: hash(claimSecret),
      expires,
      status: "pending",
    });
    return { requestId, claimSecret, verificationCode, expiresAt: new Date(expires).toISOString() };
  }

  inspect(requestId: string) {
    const request = this.get(requestId);
    return {
      requestId,
      label: request.label,
      verificationCode: request.verificationCode,
      status: request.expires <= this.now() ? ("expired" as const) : request.status,
      expiresAt: new Date(request.expires).toISOString(),
    };
  }

  approve(requestId: string, identity: FeishuIdentityRef) {
    const parsed = FeishuIdentityRefSchema.safeParse(identity);
    if (!parsed.success)
      throw new CliAuthError("CLI_AUTH_USER_REQUIRED", "必须由已认证飞书用户授权", 403);
    const request = this.getLive(requestId);
    if (request.status !== "pending")
      throw new CliAuthError("CLI_AUTH_ALREADY_APPROVED", "此请求已处理", 409);
    request.identity = { ...parsed.data };
    request.status = "approved";
    return this.inspect(requestId);
  }

  complete(
    requestId: string,
    claimSecret: string,
  ): { status: "pending" } | { token: string; identity: FeishuIdentityRef; expiresAt: string } {
    const request = this.getLive(requestId);
    if (typeof claimSecret !== "string" || !timingSafeEqual(request.secretHash, hash(claimSecret)))
      throw new CliAuthError("CLI_AUTH_INVALID_CLAIM", "领取凭据无效");
    if (request.status === "claimed")
      throw new CliAuthError("CLI_AUTH_ALREADY_CLAIMED", "此请求已领取", 409);
    if (request.status === "pending") return { status: "pending" };
    const identity = { ...request.identity! };
    const token = this.randomToken();
    const expires = this.now() + this.sessionTtlMs;
    // No await between status transition and issuance: concurrent callers cannot claim twice.
    request.status = "claimed";
    this.sessions.set(hash(token).toString("hex"), { identity, expires });
    return { token, identity: { ...identity }, expiresAt: new Date(expires).toISOString() };
  }

  authenticate(token: string): FeishuIdentityRef {
    const key = hash(token).toString("hex");
    const session = this.sessions.get(key);
    if (!session || session.expires <= this.now()) {
      this.sessions.delete(key);
      throw new CliAuthError("CLI_AUTH_SESSION_INVALID", "CLI 用户会话失效，请重新登录");
    }
    return { ...session.identity };
  }

  revoke(token: string): void {
    this.sessions.delete(hash(token).toString("hex"));
  }

  private get(requestId: string): Challenge {
    const request = this.challenges.get(requestId);
    if (!request) throw new CliAuthError("CLI_AUTH_REQUEST_NOT_FOUND", "登录请求不存在", 404);
    return request;
  }

  private getLive(requestId: string): Challenge {
    const request = this.get(requestId);
    if (request.expires <= this.now())
      throw new CliAuthError("CLI_AUTH_REQUEST_EXPIRED", "登录请求已过期", 410);
    return request;
  }
}

/** Keep the shared HTTP envelope while retaining a machine-readable pairing reason. */
export function cliAuthOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof CliAuthError)) throw error;
    throw new AppError(
      error.statusCode === 401
        ? "UNAUTHENTICATED"
        : error.statusCode === 403
          ? "FORBIDDEN"
          : error.statusCode === 404
            ? "NOT_FOUND"
            : "INVALID_REQUEST",
      error.statusCode,
      error.message,
      { details: { reason: error.code } },
    );
  }
}
