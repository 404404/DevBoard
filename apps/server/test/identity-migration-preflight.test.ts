import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, CORE_MIGRATIONS } from "../src/modules/database/index.js";
import { resolveLegacyIdentities } from "../src/modules/identity/identity-migration-preflight.js";

function fixture() {
  const database = openDatabase(":memory:");
  runMigrations(
    database,
    CORE_MIGRATIONS.filter((m) => m.version < 21),
  );
  database
    .prepare("INSERT INTO actors(id,tenant_key,open_id,name,role) VALUES(?,?,?,?,?)")
    .run("11111111-1111-4111-8111-111111111111", "tenant-a", "ou_old", "Alice", "admin");
  return database;
}
const options = { appId: "cli_old", appSecret: "secret", apiBaseUrl: "https://open.feishu.cn" };
function fetcher(
  tenant = "tenant-a",
  user: Record<string, unknown> = { open_id: "ou_old", user_id: "user-a" },
): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("tenant_access_token/internal"))
      return Response.json({ code: 0, tenant_access_token: "token" });
    if (url.pathname.endsWith("tenant/query"))
      return Response.json({ code: 0, data: { tenant: { tenant_key: tenant } } });
    expect(url.searchParams.get("user_id_type")).toBe("open_id");
    expect(url.pathname).toBe("/open-apis/contact/v3/users/ou_old");
    return Response.json({ code: 0, data: { user } });
  };
}
describe("identity migration preflight", () => {
  it("resolves authenticated tenant/open_id mapping without writing old data", async () => {
    const db = fixture();
    try {
      const mappings = await resolveLegacyIdentities(db, { ...options, fetcher: fetcher() });
      expect(mappings).toEqual([
        {
          legacyActorId: "11111111-1111-4111-8111-111111111111",
          tenantKey: "tenant-a",
          openId: "ou_old",
          userId: "user-a",
        },
      ]);
      expect(db.prepare("SELECT open_id FROM actors").pluck().get()).toBe("ou_old");
    } finally {
      db.close();
    }
  });
  it.each([
    ["other-tenant", { open_id: "ou_old", user_id: "user-a" }],
    ["tenant-a", { open_id: "ou_other", user_id: "user-a" }],
    ["tenant-a", { open_id: "ou_old" }],
  ])("fails closed on an unverifiable mapping", async (tenant, user) => {
    const db = fixture();
    try {
      await expect(
        resolveLegacyIdentities(db, {
          ...options,
          fetcher: fetcher(tenant as string, user as Record<string, unknown>),
        }),
      ).rejects.toThrow();
      expect(db.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });
  it("skips the exact historical service identity without requiring app credentials", async () => {
    const db = openDatabase(":memory:");
    try {
      runMigrations(
        db,
        CORE_MIGRATIONS.filter((m) => m.version < 21),
      );
      db.prepare("INSERT INTO actors(id,tenant_key,open_id,name,role) VALUES(?,?,?,?,?)").run(
        "00000000-0000-4000-8000-000000000001",
        "development-tenant",
        "development-user",
        "Local service",
        "admin",
      );
      expect(
        await resolveLegacyIdentities(db, {
          apiBaseUrl: options.apiBaseUrl,
          fetcher: async () => {
            throw new Error("Unexpected network request");
          },
        }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("fails before mutation when the API refuses access", async () => {
    const db = fixture();
    try {
      await expect(
        resolveLegacyIdentities(db, {
          ...options,
          fetcher: async () => Response.json({ code: 99991672, msg: "permission denied" }),
        }),
      ).rejects.toThrow(/权限/);
      expect(db.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(1);
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='identities'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it("does not request credentials for a new database", async () => {
    const db = openDatabase(":memory:");
    try {
      expect(await resolveLegacyIdentities(db, options)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
