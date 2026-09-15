import type { Migration } from "../migrator.js";
export const webAccountsMigration: Migration = {
  version: 23,
  name: "web_accounts",
  foreignKeysDisabled: true,
  sql: `CREATE TABLE web_accounts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
  ) STRICT;`,
  transformChecksum: "web-identities-v1",
  transform(database) {
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='identities'")
      .get() as { sql: string };
    const indexes = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name='identities' AND sql IS NOT NULL AND type IN ('index','trigger')",
      )
      .all() as { sql: string }[];
    const sql = row.sql
      .replace("CREATE TABLE identities", "CREATE TABLE identities_web")
      .replace("'feishu', 'service'", "'feishu', 'service', 'web'")
      .replace(
        "OR\n",
        "OR (kind = 'web' AND tenant_key IS NULL AND user_id IS NOT NULL AND service_id IS NULL AND identity_key = json_array('web', user_id)) OR\n",
      );
    database.exec(sql);
    database.exec(
      "INSERT INTO identities_web SELECT * FROM identities; DROP TABLE identities; ALTER TABLE identities_web RENAME TO identities;",
    );
    for (const index of indexes) database.exec(index.sql);
  },
};
