import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly transformChecksum?: string;
  readonly transform?: (database: Database.Database) => void;
  readonly foreignKeysDisabled?: boolean;
}

interface AppliedMigration {
  version: number;
  checksum: string;
}

export class MigrationError extends Error {
  readonly version: number | undefined;

  constructor(message: string, options: { version?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "MigrationError";
    this.version = options.version;
  }
}

function checksum(migration: Migration): string {
  const digest = createHash("sha256").update(migration.sql);
  if (migration.transform) {
    digest.update("\0").update(migration.transformChecksum as string);
  }
  return digest.digest("hex");
}

function validateMigrations(migrations: readonly Migration[]): readonly Migration[] {
  const sorted = [...migrations].sort((left, right) => left.version - right.version);
  const versions = new Set<number>();

  for (const migration of sorted) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new MigrationError(`迁移版本必须是正整数：${migration.version}`);
    }
    if (versions.has(migration.version)) {
      throw new MigrationError(`发现重复迁移版本：${migration.version}`, {
        version: migration.version,
      });
    }
    if (migration.name.trim().length === 0 || migration.sql.trim().length === 0) {
      throw new MigrationError(`迁移 ${migration.version} 缺少名称或 SQL`, {
        version: migration.version,
      });
    }
    if (Boolean(migration.transform) !== Boolean(migration.transformChecksum?.trim())) {
      throw new MigrationError(`迁移 ${migration.version} 的数据转换缺少稳定校验标识`, {
        version: migration.version,
      });
    }
    versions.add(migration.version);
  }

  return sorted;
}

function ensureMigrationTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);
}

export function runMigrations(
  database: Database.Database,
  migrations: readonly Migration[],
): readonly number[] {
  const sorted = validateMigrations(migrations);
  ensureMigrationTable(database);

  const applied = database
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as AppliedMigration[];
  const expectedByVersion = new Map(sorted.map((migration) => [migration.version, migration]));

  for (const record of applied) {
    const expected = expectedByVersion.get(record.version);
    if (!expected) {
      throw new MigrationError(
        `数据库包含当前程序未知的迁移版本：${record.version}，拒绝使用较旧程序打开`,
        { version: record.version },
      );
    }
    if (record.checksum !== checksum(expected)) {
      throw new MigrationError(`已应用迁移 ${record.version} 的内容与当前代码不一致`, {
        version: record.version,
      });
    }
  }

  const appliedVersions = new Set(applied.map((record) => record.version));
  const newlyApplied: number[] = [];
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
  );

  for (const migration of sorted) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    try {
      const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
      if (migration.foreignKeysDisabled) database.pragma("foreign_keys = OFF");
      try {
        database.transaction(() => {
          database.exec(migration.sql);
          migration.transform?.(database);
          if (migration.foreignKeysDisabled) {
            const violations = database.pragma("foreign_key_check") as unknown[];
            if (violations.length > 0) {
              throw new Error(`迁移产生 ${violations.length} 项外键错误`);
            }
          }
          insertMigration.run(migration.version, migration.name, checksum(migration));
        })();
      } finally {
        if (migration.foreignKeysDisabled && foreignKeysEnabled) {
          database.pragma("foreign_keys = ON");
        }
      }
      newlyApplied.push(migration.version);
    } catch (cause: unknown) {
      throw new MigrationError(`迁移 ${migration.version}（${migration.name}）执行失败`, {
        version: migration.version,
        cause,
      });
    }
  }

  return newlyApplied;
}

export function pendingMigrationVersions(
  database: Database.Database,
  migrations: readonly Migration[],
): readonly number[] {
  const sorted = validateMigrations(migrations);
  ensureMigrationTable(database);
  const applied = database
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as AppliedMigration[];
  const expectedByVersion = new Map(sorted.map((migration) => [migration.version, migration]));
  for (const record of applied) {
    const expected = expectedByVersion.get(record.version);
    if (!expected) {
      throw new MigrationError(
        `数据库包含当前程序未知的迁移版本：${record.version}，拒绝使用较旧程序打开`,
        { version: record.version },
      );
    }
    if (record.checksum !== checksum(expected)) {
      throw new MigrationError(`已应用迁移 ${record.version} 的内容与当前代码不一致`, {
        version: record.version,
      });
    }
  }
  const appliedVersions = new Set(applied.map((record) => record.version));
  return sorted
    .filter((migration) => !appliedVersions.has(migration.version))
    .map((migration) => migration.version);
}
