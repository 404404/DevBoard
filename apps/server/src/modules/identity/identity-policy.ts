import { identityFromKey, identityKey, type PrincipalView } from "@lark-codex/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";

// Registration, a user_id, a name or an administrator role is not
// identity evidence. Only the server's successful Feishu login event is.
export const FEISHU_IDENTITY_SQL = `
  identities.kind = 'feishu'
  AND EXISTS (
    SELECT 1 FROM audit_events AS identity_evidence
    WHERE identity_evidence.identity_key = identities.identity_key
      AND identity_evidence.action = 'session.login'
      AND identity_evidence.outcome = 'allowed'
      AND json_extract(identity_evidence.safe_metadata_json, '$.provider') = 'feishu'
  )`;

export function hasFeishuIdentity(database: SqliteDatabase, principalKey: string): boolean {
  return Boolean(
    database
      .prepare(`SELECT 1 FROM identities WHERE identity_key = ? AND ${FEISHU_IDENTITY_SQL}`)
      .get(principalKey),
  );
}

/** HTTP sessions and local transports authenticate callers before applying this policy. */
export function hasBoardAccess(database: SqliteDatabase, actor: PrincipalView): boolean {
  const key = identityKey(actor.identity);
  if (actor.identity.kind === "feishu") {
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM identities WHERE identity_key = ? AND active = 1 AND ${FEISHU_IDENTITY_SQL}`,
        )
        .get(key),
    );
  }
  if (actor.identity.kind === "web") return hasWebIdentity(database, key);
  // Preserve the existing local-only service; caller-supplied names or roles grant nothing.
  return (
    actor.identity.serviceId === "local-admin" &&
    Boolean(
      database
        .prepare(
          "SELECT 1 FROM identities WHERE identity_key = ? AND kind = 'service' AND service_id = 'local-admin' AND active = 1 AND role = 'admin'",
        )
        .get(key),
    )
  );
}

export function hasWebIdentity(database: SqliteDatabase, key: string): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM identities JOIN web_accounts ON web_accounts.id = identities.user_id
    WHERE identity_key = ? AND kind = 'web' AND active = 1`,
      )
      .get(key),
  );
}
export function assertUserAssignee(database: SqliteDatabase, key: string | null): void {
  if (key && hasWebIdentity(database, key)) return;
  assertFeishuAssignee(database, key);
}

export function assertBoardAccess(database: SqliteDatabase, actor: PrincipalView): void {
  if (!hasBoardAccess(database, actor)) {
    throw new AppError("FORBIDDEN", 403, "请先通过飞书登录验证身份");
  }
}

export function assertFeishuAssignee(database: SqliteDatabase, principalKey: string | null): void {
  if (
    !principalKey ||
    !database
      .prepare(
        `SELECT 1 FROM identities WHERE identity_key = ? AND active = 1 AND ${FEISHU_IDENTITY_SQL}`,
      )
      .get(principalKey)
  ) {
    throw new AppError(
      "INVALID_REQUEST",
      400,
      "负责人必须是已通过飞书登录验证的有效用户；请先从飞书登录",
    );
  }
}

const AuditActorRowSchema = z.object({
  principalKey: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
  active: z.number().int(),
  localService: z.number().int(),
  verified: z.number().int(),
  webAccount: z.number().int(),
  lastFeishuLoginAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  assignedTasks: z.number().int(),
  authoredComments: z.number().int(),
});

export function readIdentityAudit(database: SqliteDatabase) {
  const rows = database
    .prepare(
      `
    SELECT identities.identity_key AS principalKey, identities.name, identities.role, identities.active,
      (identities.kind = 'service') AS localService,
      (${FEISHU_IDENTITY_SQL}) AS verified,
      (identities.kind = 'web' AND EXISTS (SELECT 1 FROM web_accounts WHERE id = identities.user_id)) AS webAccount,
      (SELECT MAX(created_at) FROM audit_events WHERE identity_key = identities.identity_key
        AND action = 'session.login' AND outcome = 'allowed'
        AND json_extract(safe_metadata_json, '$.provider') = 'feishu') AS lastFeishuLoginAt,
      (SELECT MAX(created_at) FROM audit_events WHERE identity_key = identities.identity_key
        AND action = 'session.login' AND outcome = 'allowed') AS lastLoginAt,
      (SELECT COUNT(*) FROM tasks WHERE assignee_identity_key = identities.identity_key) AS assignedTasks,
      (SELECT COUNT(*) FROM comments WHERE author_identity_key = identities.identity_key AND deleted_at IS NULL) AS authoredComments
    FROM identities ORDER BY identities.created_at, identities.identity_key
  `,
    )
    .all();
  const identities = rows.map((row) => {
    const { localService, verified, webAccount, active, principalKey, ...actor } =
      AuditActorRowSchema.parse(row);
    return {
      ...actor,
      identity: identityFromKey(principalKey),
      active: active === 1,
      identityKind: localService
        ? "local_service"
        : verified
          ? "feishu"
          : webAccount
            ? "web"
            : "unverified",
      eligibleAssignee: active === 1 && (verified === 1 || webAccount === 1),
      evidence: verified
        ? "feishu_login"
        : webAccount
          ? "local_provisioning"
          : actor.lastLoginAt
            ? "historical_login"
            : "none",
    };
  });
  return {
    identities,
    summary: {
      total: identities.length,
      verifiedFeishu: identities.filter((actor) => actor.identityKind === "feishu").length,
      localService: identities.filter((actor) => actor.identityKind === "local_service").length,
      unverified: identities.filter((actor) => actor.identityKind === "unverified").length,
      ineligibleAssignments: identities
        .filter((actor) => !actor.eligibleAssignee)
        .reduce((count, actor) => count + actor.assignedTasks, 0),
      nonFeishuComments: identities
        .filter((actor) => actor.identityKind !== "feishu")
        .reduce((count, actor) => count + actor.authoredComments, 0),
    },
  };
}
