import { z } from "zod";
import type { LegacyIdentityMapping, SqliteDatabase } from "../database/index.js";

const PREFLIGHT_MESSAGES = {
  credentials: "旧用户迁移需要原飞书应用凭证",
  upstream: "身份迁移映射读取失败，请检查网络、原应用通讯录与 user_id 权限",
  tenant: "旧用户租户与原应用租户不匹配，迁移已停止",
  mapping: "无法验证旧 open_id 对应的 user_id，迁移已停止",
} as const;
export class IdentityMigrationPreflightError extends Error {
  readonly code = "IDENTITY_MIGRATION_PREFLIGHT_FAILED";
  constructor(
    readonly reason: keyof typeof PREFLIGHT_MESSAGES,
    cause?: unknown,
  ) {
    super(PREFLIGHT_MESSAGES[reason], { cause });
    this.name = "IdentityMigrationPreflightError";
  }
}

interface Options {
  readonly appId?: string | undefined;
  readonly appSecret?: string | undefined;
  readonly apiBaseUrl: string;
  readonly fetcher?: typeof fetch;
}
const LegacyRow = z.object({ id: z.string(), tenant_key: z.string(), open_id: z.string() });

/** Read-only preflight using the original application's credentials. Never infer identity from a name. */
async function resolveMappings(
  database: SqliteDatabase,
  options: Options,
): Promise<readonly LegacyIdentityMapping[]> {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='actors'").get())
    return [];
  const rows = z
    .array(LegacyRow)
    .parse(database.prepare("SELECT id,tenant_key,open_id FROM actors").all())
    .filter(
      (row) =>
        !(
          row.id === "00000000-0000-4000-8000-000000000001" &&
          row.tenant_key === "development-tenant" &&
          row.open_id === "development-user"
        ),
    );
  if (!rows.length) return [];
  if (!options.appId || !options.appSecret)
    throw new IdentityMigrationPreflightError("credentials");
  const fetcher = options.fetcher ?? fetch;
  async function request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetcher(new URL(path, options.apiBaseUrl), {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new IdentityMigrationPreflightError("upstream");
    const result = z
      .object({ code: z.literal(0) })
      .passthrough()
      .safeParse(await response.json());
    if (!result.success) throw new IdentityMigrationPreflightError("upstream");
    return result.data;
  }
  const tokenPayload = await request("/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
  });
  const token = z.string().min(1).parse(tokenPayload.tenant_access_token);
  const headers = { Authorization: `Bearer ${token}` };
  const tenantPayload = await request("/open-apis/tenant/v2/tenant/query", { headers });
  const tenantKey = z
    .object({ tenant: z.object({ tenant_key: z.string().min(1) }) })
    .parse(tenantPayload.data).tenant.tenant_key;
  if (rows.some((row) => row.tenant_key !== tenantKey))
    throw new IdentityMigrationPreflightError("tenant");
  const mappings: LegacyIdentityMapping[] = [];
  for (const row of rows) {
    const payload = await request(
      `/open-apis/contact/v3/users/${encodeURIComponent(row.open_id)}?user_id_type=open_id`,
      { headers },
    );
    const parsed = z
      .object({
        user: z.object({
          open_id: z.literal(row.open_id),
          user_id: z.string().trim().min(1).max(255),
        }),
      })
      .safeParse(payload.data);
    if (!parsed.success) throw new IdentityMigrationPreflightError("mapping");
    mappings.push({
      legacyActorId: row.id,
      tenantKey,
      openId: row.open_id,
      userId: parsed.data.user.user_id,
    });
  }
  return mappings;
}

export async function resolveLegacyIdentities(
  database: SqliteDatabase,
  options: Options,
): Promise<readonly LegacyIdentityMapping[]> {
  try {
    return await resolveMappings(database, options);
  } catch (error) {
    if (error instanceof IdentityMigrationPreflightError) throw error;
    throw new IdentityMigrationPreflightError("upstream", error);
  }
}
