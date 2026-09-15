import {
  identityKey,
  identityFromKey,
  IdentityKeySchema,
  IdentityRefSchema,
  type IdentityRef,
} from "@codexboard/contracts";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { PrincipalViewSchema, type PrincipalView } from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import {
  type ExternalIdentity,
  type IdentityProvider,
  IdentityProviderError,
} from "./identity-provider.js";
import {
  assertBoardAccess,
  hasBoardAccess,
  hasFeishuIdentity,
  hasWebIdentity,
} from "./identity-policy.js";

const PrincipalRowSchema = z.object({
  principalKey: IdentityKeySchema,
  name: z.string().min(1),
  avatarUrl: z.url().nullable(),
  role: z.enum(["admin", "member"]),
  active: z.number().int(),
});

const SessionRowSchema = z.object({
  idHash: z.string().length(64),
  csrfHash: z.string().length(64),
  expiresAt: z.string().datetime(),
  principalKey: IdentityKeySchema,
  actorName: z.string().min(1),
  actorAvatarUrl: z.url().nullable(),
  actorRole: z.enum(["admin", "member"]),
});

export interface SessionGrant {
  readonly actor: PrincipalView;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface SessionContext {
  readonly idHash: string;
  readonly csrfHash: string;
  readonly expiresAt: string;
  readonly actor: PrincipalView;
}

export type ProjectAction = "read" | "write" | "execute" | "admin";

interface IdentityServiceOptions {
  readonly database: SqliteDatabase;
  readonly provider: IdentityProvider;
  readonly sessionTtlSeconds: number;
  readonly now?: () => Date;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesMatch(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class IdentityService {
  readonly #database: SqliteDatabase;
  readonly #provider: IdentityProvider;
  readonly #sessionTtlSeconds: number;
  readonly #now: () => Date;

  constructor(options: IdentityServiceOptions) {
    this.#database = options.database;
    this.#provider = options.provider;
    this.#sessionTtlSeconds = options.sessionTtlSeconds;
    this.#now = options.now ?? (() => new Date());
  }

  ensureDevelopmentActor(external: ExternalIdentity): void {
    if (external.identity.kind !== "service" || external.identity.serviceId !== "local-admin") {
      throw new AppError("INVALID_REQUEST", 400, "开发入口仅支持本机服务身份");
    }
    this.#database
      .prepare(
        `INSERT INTO identities (
      identity_key, kind, tenant_key, user_id, service_id, name, avatar_url, role, active
    ) VALUES (?, 'service', NULL, NULL, 'local-admin', ?, ?, 'admin', 1)
    ON CONFLICT (identity_key) DO UPDATE SET name = excluded.name,
      avatar_url = excluded.avatar_url, active = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(identityKey(external.identity), external.name, external.avatarUrl);
  }

  #recordAudit(
    action: string,
    outcome: "allowed" | "denied" | "failed",
    principalKey: string | null,
    metadata: Record<string, unknown>,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome, safe_metadata_json
        ) VALUES (?, ?, ?, 'session', NULL, ?, ?)`,
      )
      .run(randomUUID(), principalKey, action, outcome, JSON.stringify(metadata));
  }

  #findActor(external: ExternalIdentity): PrincipalView {
    const identity = IdentityRefSchema.parse(external.identity);
    if ((this.#provider.kind === "feishu") !== (identity.kind === "feishu")) {
      throw new AppError("FORBIDDEN", 403, "登录来源与身份类型不匹配");
    }
    const key = identityKey(identity);
    // Only the provider's completed code exchange reaches this path. Never enroll a
    // user supplied by a command, query string, display name, or local registration.
    if (identity.kind === "feishu") {
      const profile = PrincipalViewSchema.parse({
        identity,
        name: external.name,
        avatarUrl: external.avatarUrl,
        role: "member",
      });
      this.#database
        .prepare(
          `INSERT INTO identities (
        identity_key, kind, tenant_key, user_id, service_id, name, avatar_url, role, active
      ) VALUES (?, 'feishu', ?, ?, NULL, ?, ?, 'member', 1)
      ON CONFLICT (identity_key) DO UPDATE SET name = excluded.name,
        avatar_url = coalesce(excluded.avatar_url, identities.avatar_url), active = 1,
        updated_at = ?`,
        )
        .run(
          key,
          identity.tenantKey,
          identity.userId,
          profile.name,
          profile.avatarUrl,
          this.#now().toISOString(),
        );
    }
    const parsed = PrincipalRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT identity_key AS principalKey,
        name, avatar_url AS avatarUrl, role, active FROM identities WHERE identity_key = ?`,
        )
        .get(key),
    );
    if (!parsed.success || parsed.data.active !== 1) {
      this.#recordAudit("session.login", "denied", parsed.success ? key : null, {
        identityFingerprint: hashSecret(key).slice(0, 16),
      });
      throw new AppError("FORBIDDEN", 403, "当前企业成员没有使用权限");
    }
    const avatarUrl = external.avatarUrl ?? parsed.data.avatarUrl;
    const name = external.name;
    if (avatarUrl !== parsed.data.avatarUrl || name !== parsed.data.name) {
      this.#database
        .prepare(
          "UPDATE identities SET name = ?, avatar_url = ?, updated_at = ? WHERE identity_key = ?",
        )
        .run(name, avatarUrl, this.#now().toISOString(), key);
    }
    return PrincipalViewSchema.parse({ identity, name, avatarUrl, role: parsed.data.role });
  }

  /** Revalidates an authenticated CLI session against current membership and login evidence. */
  authenticatedFeishuPrincipal(identity: IdentityRef): PrincipalView {
    if (identity.kind !== "feishu") throw new AppError("UNAUTHENTICATED", 401, "需要飞书用户身份");
    const key = identityKey(identity);
    const parsed = PrincipalRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT identity_key AS principalKey,
      name, avatar_url AS avatarUrl, role, active FROM identities WHERE identity_key = ?`,
        )
        .get(key),
    );
    if (!parsed.success || parsed.data.active !== 1 || !hasFeishuIdentity(this.#database, key)) {
      throw new AppError("UNAUTHENTICATED", 401, "用户已停用或需要重新从飞书登录");
    }
    return PrincipalViewSchema.parse({
      identity,
      name: parsed.data.name,
      avatarUrl: parsed.data.avatarUrl,
      role: parsed.data.role,
    });
  }

  async exchangeCode(code: string): Promise<SessionGrant> {
    let identity: ExternalIdentity;

    try {
      identity = await this.#provider.exchangeCode(code);
    } catch (cause: unknown) {
      this.#recordAudit("session.login", "failed", null, { reason: "identity_provider" });
      throw new AppError("UPSTREAM_ERROR", 502, "飞书身份校验失败", {
        cause: cause instanceof IdentityProviderError ? cause : undefined,
      });
    }

    return this.#createSession(this.#findActor(identity));
  }

  async loginDevelopment(): Promise<SessionGrant> {
    const identity = await this.#provider.exchangeCode("development");
    return this.#createSession(this.#findActor(identity));
  }

  loginWebAccount(accountId: string): SessionGrant {
    const identity = { kind: "web" as const, accountId };
    const key = identityKey(identity);
    if (!hasWebIdentity(this.#database, key))
      throw new AppError("UNAUTHENTICATED", 401, "账号或密码错误");
    const row = PrincipalRowSchema.parse(
      this.#database
        .prepare(
          `SELECT identity_key AS principalKey, name, avatar_url AS avatarUrl, role, active FROM identities WHERE identity_key = ?`,
        )
        .get(key),
    );
    return this.#createSession(
      PrincipalViewSchema.parse({
        identity,
        name: row.name,
        avatarUrl: row.avatarUrl,
        role: row.role,
      }),
      "web",
    );
  }

  #createSession(actor: PrincipalView, provider: string = this.#provider.kind): SessionGrant {
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      this.#now().getTime() + this.#sessionTtlSeconds * 1_000,
    ).toISOString();

    withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO sessions (
            id_hash, identity_key, csrf_hash, expires_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          hashSecret(sessionToken),
          identityKey(actor.identity),
          hashSecret(csrfToken),
          expiresAt,
        );
      this.#recordAudit("session.login", "allowed", identityKey(actor.identity), {
        provider,
      });
    });

    return { actor, sessionToken, csrfToken, expiresAt };
  }

  authenticate(sessionToken: string | undefined): SessionContext {
    if (!sessionToken) {
      throw new AppError("UNAUTHENTICATED", 401, "需要登录后才能访问");
    }

    const idHash = hashSecret(sessionToken);
    const now = this.#now().toISOString();
    const row: unknown = this.#database
      .prepare(
        `SELECT
          sessions.id_hash AS idHash,
          sessions.csrf_hash AS csrfHash,
          sessions.expires_at AS expiresAt,
          identities.identity_key AS principalKey,
          identities.name AS actorName,
          identities.avatar_url AS actorAvatarUrl,
          identities.role AS actorRole
        FROM sessions
        JOIN identities ON identities.identity_key = sessions.identity_key
        WHERE sessions.id_hash = ?
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > ?
          AND identities.active = 1`,
      )
      .get(idHash, now);
    const parsed = SessionRowSchema.safeParse(row);

    if (!parsed.success) {
      throw new AppError("UNAUTHENTICATED", 401, "会话无效或已过期");
    }

    if (
      this.#provider.kind === "web" &&
      !hasWebIdentity(this.#database, parsed.data.principalKey)
    ) {
      throw new AppError("UNAUTHENTICATED", 401, "请使用 Web 账号重新登录");
    }

    if (
      this.#provider.kind === "feishu" &&
      !hasFeishuIdentity(this.#database, parsed.data.principalKey) &&
      !hasWebIdentity(this.#database, parsed.data.principalKey)
    ) {
      throw new AppError("UNAUTHENTICATED", 401, "需要重新从飞书登录以验证身份");
    }

    this.#database
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?")
      .run(now, idHash);

    return {
      idHash: parsed.data.idHash,
      csrfHash: parsed.data.csrfHash,
      expiresAt: parsed.data.expiresAt,
      actor: PrincipalViewSchema.parse({
        identity: identityFromKey(parsed.data.principalKey),
        name: parsed.data.actorName,
        avatarUrl: parsed.data.actorAvatarUrl,
        role: parsed.data.actorRole,
      }),
    };
  }

  assertBoardAccess(actor: PrincipalView): void {
    assertBoardAccess(this.#database, actor);
  }

  authorizeProject(actor: PrincipalView, projectId: string, action: ProjectAction): void {
    if (!hasBoardAccess(this.#database, actor)) {
      const key = identityKey(actor.identity);
      const exists = this.#database
        .prepare("SELECT 1 FROM identities WHERE identity_key = ?")
        .get(key);
      this.#recordAudit("project.authorize", "denied", exists ? key : null, {
        action,
        projectId,
        identityFingerprint: hashSecret(key).slice(0, 16),
      });
      throw new AppError("FORBIDDEN", 403, "请先通过飞书登录验证身份");
    }
  }

  assertCsrf(
    context: SessionContext,
    headerToken: string | undefined,
    cookieToken: string | undefined,
  ) {
    if (!headerToken || !cookieToken || headerToken !== cookieToken) {
      throw new AppError("CSRF_INVALID", 403, "CSRF 校验失败");
    }

    if (!hashesMatch(context.csrfHash, hashSecret(headerToken))) {
      throw new AppError("CSRF_INVALID", 403, "CSRF 校验失败");
    }
  }

  revoke(context: SessionContext): void {
    const revokedAt = this.#now().toISOString();

    withTransaction(this.#database, () => {
      this.#database
        .prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
        .run(revokedAt, context.idHash);
      this.#recordAudit("session.logout", "allowed", identityKey(context.actor.identity), {});
    });
  }
}
