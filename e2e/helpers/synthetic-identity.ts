import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { APIRequestContext } from "@playwright/test";
import { identityKey, type FeishuIdentityRef } from "@codexboard/contracts";
import Database from "better-sqlite3";

export const SYNTHETIC_FEISHU_IDENTITY: FeishuIdentityRef = {
  kind: "feishu",
  tenantKey: "e2e-synthetic-tenant",
  userId: "e2e-synthetic-user",
};
export const SYNTHETIC_FEISHU_NAME = "E2E 飞书测试用户";

function isolatedDataDirectory(): string {
  const configured = process.env.CODEXBOARD_DATA_DIR;
  if (!configured)
    throw new Error("Run E2E through scripts/run-e2e.mjs with an isolated data directory");
  const directory = realpathSync(configured);
  if (
    dirname(directory) !== realpathSync(tmpdir()) ||
    !basename(directory).startsWith("codexboard-e2e-")
  ) {
    throw new Error(
      "Synthetic identity fixtures may only access the E2E runner's temporary directory",
    );
  }
  return directory;
}

export function syntheticAuthFile(): string {
  return join(isolatedDataDirectory(), "run", "synthetic-taskctl-auth");
}

export function e2eOrigin(): string {
  const origin = process.env.CODEXBOARD_ORIGIN;
  if (!origin || new URL(origin).hostname !== "127.0.0.1")
    throw new Error("E2E requires its isolated loopback origin");
  return origin;
}

/**
 * Test-only identity evidence, never a production authentication path: the real development
 * endpoint creates private cookies, then this fixture binds only that session's hash to a
 * synthetic Feishu principal in the runner's disposable SQLite database. No Feishu token is
 * forged or obtained. CLI credentials are still issued through the real pairing endpoints.
 */
export async function establishSyntheticFeishuSession(request: APIRequestContext): Promise<string> {
  const directory = isolatedDataDirectory();
  const origin = e2eOrigin();
  const login = await request.post(`${origin}/api/v1/auth/development`, {
    headers: { Origin: origin },
  });
  if (login.status() !== 201)
    throw new Error(`Synthetic fixture development session failed: HTTP ${login.status()}`);
  const { data } = (await login.json()) as { data: { csrfToken: string } };
  const state = await request.storageState();
  const session = state.cookies.find((cookie) => cookie.name === "codexboard_session");
  if (!session) throw new Error("The E2E development endpoint did not issue a session cookie");

  const databasePath = join(directory, "taskboard.sqlite");
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("E2E database must be a regular temporary file");
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database
      .transaction(() => {
        const key = identityKey(SYNTHETIC_FEISHU_IDENTITY);
        database
          .prepare(
            `INSERT INTO identities(identity_key, kind, tenant_key, user_id, name, role, active)
        VALUES (?, 'feishu', ?, ?, ?, 'admin', 1)
        ON CONFLICT(identity_key) DO NOTHING`,
          )
          .run(
            key,
            SYNTHETIC_FEISHU_IDENTITY.tenantKey,
            SYNTHETIC_FEISHU_IDENTITY.userId,
            SYNTHETIC_FEISHU_NAME,
          );
        database
          .prepare(
            `INSERT INTO audit_events(id,identity_key,action,resource_type,outcome,safe_metadata_json)
        VALUES (?,?,'session.login','session','allowed',?)`,
          )
          .run(
            randomUUID(),
            key,
            JSON.stringify({ provider: "feishu", syntheticFixture: "isolated-e2e" }),
          );
        const changed = database
          .prepare("UPDATE sessions SET identity_key = ? WHERE id_hash = ? AND revoked_at IS NULL")
          .run(key, createHash("sha256").update(session.value).digest("hex"));
        if (changed.changes !== 1)
          throw new Error("Synthetic fixture must bind exactly its own browser session");
      })
      .immediate();
  } finally {
    database.close();
  }
  return data.csrfToken;
}
