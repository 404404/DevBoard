import {
  resolveLegacyIdentities,
  IdentityMigrationPreflightError,
} from "./modules/identity/identity-migration-preflight.js";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { identityMigrations, MigrationError, openDatabase } from "./modules/database/index.js";
import {
  acquireDataDirectoryLock,
  BackupService,
  recoverInterruptedRestore,
  runMigrationsWithBackup,
} from "./modules/operations/index.js";

try {
  const config = loadConfig();
  const dataLock = acquireDataDirectoryLock(config.CODEXBOARD_DATA_DIR, "migration");
  let database: ReturnType<typeof openDatabase> | undefined;

  try {
    recoverInterruptedRestore(config.CODEXBOARD_DATA_DIR);
    database = openDatabase(join(config.CODEXBOARD_DATA_DIR, "taskboard.sqlite"));
    const result = await runMigrationsWithBackup(
      database,
      identityMigrations(
        await resolveLegacyIdentities(database, {
          appId: config.CODEXBOARD_FEISHU_APP_ID,
          appSecret: config.CODEXBOARD_FEISHU_APP_SECRET,
          apiBaseUrl: config.CODEXBOARD_FEISHU_API_BASE_URL,
        }),
      ),
      new BackupService({ database, dataDirectory: config.CODEXBOARD_DATA_DIR }),
    );
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    if (database?.open) database.close();
    dataLock.release();
  }
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code:
        error instanceof IdentityMigrationPreflightError
          ? error.code
          : error instanceof MigrationError
            ? "MIGRATION_FAILED"
            : "DATABASE_ERROR",
      message: error instanceof IdentityMigrationPreflightError ? error.message : "数据库迁移失败",
    })}\n`,
  );
  process.exitCode = 1;
}
