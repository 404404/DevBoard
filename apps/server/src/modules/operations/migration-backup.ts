import type { Migration, SqliteDatabase } from "../database/index.js";
import { pendingMigrationVersions, runMigrations } from "../database/index.js";
import type { BackupService } from "./backup-service.js";

export interface MigrationWithBackupResult {
  readonly appliedVersions: readonly number[];
  readonly backupPath: string | null;
}

export async function runMigrationsWithBackup(
  database: SqliteDatabase,
  migrations: readonly Migration[],
  backups: BackupService,
): Promise<MigrationWithBackupResult> {
  const pending = pendingMigrationVersions(database, migrations);
  if (pending.length === 0) return { appliedVersions: [], backupPath: null };
  const currentVersion =
    (database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get() as
      number | null) ?? 0;
  let backupPath: string | null = null;
  if (currentVersion > 0) {
    backupPath = backups.automaticDestination(
      `pre-migration-v${currentVersion}-to-v${Math.max(...pending)}`,
    );
    await backups.create(backupPath);
  }
  return { appliedVersions: runMigrations(database, migrations), backupPath };
}
