import { identityKey, type FeishuIdentityRef, type PrincipalView } from "@lark-codex/contracts";
import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../../src/modules/database/index.js";

export const TEST_FEISHU_IDENTITY: FeishuIdentityRef = {
  kind: "feishu",
  tenantKey: "test-tenant",
  userId: "test-admin",
};
export const TEST_FEISHU_ACTOR: PrincipalView = {
  identity: TEST_FEISHU_IDENTITY,
  name: "测试飞书管理员",
  avatarUrl: null,
  role: "admin",
};

/** Synthetic database fixture only: creates the principal and trusted login evidence. */
export function seedFeishuTestActor(
  database: SqliteDatabase,
  actor: PrincipalView = TEST_FEISHU_ACTOR,
): PrincipalView {
  if (actor.identity.kind !== "feishu") throw new Error("Fixture requires a Feishu identity");
  const timestamp = "2026-09-09T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO identities (identity_key,kind,tenant_key,user_id,service_id,name,avatar_url,role,active,created_at,updated_at)
    VALUES (?, 'feishu', ?, ?, NULL, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(identity_key) DO UPDATE SET name=excluded.name, avatar_url=excluded.avatar_url, role=excluded.role, active=1`,
    )
    .run(
      identityKey(actor.identity),
      actor.identity.tenantKey,
      actor.identity.userId,
      actor.name,
      actor.avatarUrl,
      actor.role,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `INSERT INTO audit_events (id, identity_key, action, resource_type, resource_id, outcome, safe_metadata_json, created_at)
    VALUES (?, ?, 'session.login', 'session', ?, 'allowed', ?, ?)`,
    )
    .run(
      randomUUID(),
      identityKey(actor.identity),
      randomUUID(),
      JSON.stringify({ provider: "feishu" }),
      timestamp,
    );
  return actor;
}
