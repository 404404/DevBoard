import type Database from "better-sqlite3";

const IDENTITY_REFERENCE_MIGRATION_SQL =
  "-- Move SSH identity paths to controlled catalog references.";

export function migrateSshIdentityReferences(database: Database.Database): void {
  const columns = new Set(
    (database.pragma("table_info(connections)") as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );

  const hasIdentityColumn = columns.has("identity");
  const hasIdentityReferenceColumn = columns.has("identity_ref");
  if (!hasIdentityColumn && !hasIdentityReferenceColumn) {
    throw new Error("connections table has neither identity nor identity_ref");
  }
  if (!hasIdentityReferenceColumn) {
    database.exec("ALTER TABLE connections ADD COLUMN identity_ref TEXT");
  }

  // Draft builds may have stored a path in identity_ref while the old identity
  // column still exists. Keep only opaque catalog ids; never migrate a path.
  const select = "SELECT id, auth_mode, identity_ref FROM connections";
  const rows = database.prepare(select).all() as Array<{
    id: string;
    auth_mode: string;
    identity_ref: string | null;
  }>;
  const update = database.prepare(`
    UPDATE connections
    SET identity_ref = ?,
        status = CASE WHEN ? = 1 THEN 'configuration_required' ELSE status END,
        last_health_json = CASE WHEN ? = 1 THEN NULL ELSE last_health_json END,
        enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
        version = CASE WHEN ? = 1 THEN version + 1 ELSE version END,
        updated_at = CASE WHEN ? = 1
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE updated_at END
    WHERE id = ?
  `);

  for (const row of rows) {
    const safeReference =
      row.identity_ref !== null &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.identity_ref) &&
      !row.identity_ref.includes("..")
        ? row.identity_ref
        : null;
    const requiresConfiguration =
      row.auth_mode === "identity_file" && safeReference === null;
    update.run(
      row.auth_mode === "agent" ? null : safeReference,
      requiresConfiguration ? 1 : 0,
      requiresConfiguration ? 1 : 0,
      requiresConfiguration ? 1 : 0,
      requiresConfiguration ? 1 : 0,
      requiresConfiguration ? 1 : 0,
      row.id,
    );
  }

  if (hasIdentityColumn) database.exec("ALTER TABLE connections DROP COLUMN identity");
}

export const SSH_IDENTITY_REFERENCES_MIGRATION = {
  version: 29,
  name: "ssh_identity_references",
  sql: IDENTITY_REFERENCE_MIGRATION_SQL,
  transformChecksum: "ssh-identity-references-v1",
  transform: migrateSshIdentityReferences,
} as const;
