import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { readIdentityAudit } from "./modules/identity/index.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BackupManifestSchema, RuntimeDescriptorSchema } from "@lark-taskboard/contracts";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { openDatabase } from "./modules/database/index.js";
import { acquireDataDirectoryLock, BackupService } from "./modules/operations/index.js";

type Output = (line: string) => void;

const OnlineBackupResponseSchema = z
  .object({
    data: z
      .object({
        backupId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
        manifest: BackupManifestSchema,
      })
      .strict(),
  })
  .strict();

export interface OperationsDependencies {
  readonly fetch?: typeof fetch;
}

function emit(output: Output, value: unknown): void {
  output(JSON.stringify(value));
}

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`选项 ${name} 缺少值`);
  return value;
}

export async function runOperations(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  output: Output = (line) => process.stdout.write(`${line}\n`),
  dependencies: OperationsDependencies = {},
): Promise<number> {
  const [command, target] = arguments_;
  if (!command || !["backup", "verify", "restore", "audit-identities"].includes(command)) {
    emit(output, {
      ok: false,
      code: "USAGE_ERROR",
      message: "用法：ops backup [--output DIR] | verify DIR | restore DIR | audit-identities DIR",
    });
    return 2;
  }

  try {
    if (command === "audit-identities") {
      if (!target) throw new Error("audit-identities 缺少备份目录");
      const manifest = BackupService.verify(target);
      const temporary = mkdtempSync(join(tmpdir(), "taskboard-identity-audit-"));
      try {
        const snapshot = join(temporary, "taskboard.sqlite");
        copyFileSync(join(resolve(target), manifest.database.path), snapshot);
        const database = new Database(snapshot, { readonly: true, fileMustExist: true });
        try {
          emit(output, {
            ok: true,
            command,
            directory: resolve(target),
            data: readIdentityAudit(database),
          });
        } finally {
          database.close();
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      return 0;
    }

    if (command === "verify") {
      if (!target) throw new Error("verify 缺少备份目录");
      const manifest = BackupService.verify(target);
      emit(output, {
        ok: true,
        command,
        directory: resolve(target),
        schemaVersion: manifest.schemaVersion,
        attachmentCount: manifest.attachments.length,
      });
      return 0;
    }

    const config = loadConfig(environment);
    if (command === "restore") {
      if (!target) throw new Error("restore 缺少备份目录");
      const result = await BackupService.restore(target, config.LARK_TASKBOARD_DATA_DIR);
      emit(output, { ok: true, command, ...result });
      return 0;
    }

    const requestedDestination = optionValue(arguments_, "--output");
    const runtimePath = join(config.LARK_TASKBOARD_DATA_DIR, "run", "runtime.json");
    if (existsSync(runtimePath)) {
      const runtimeStat = lstatSync(runtimePath);
      if (runtimeStat.isSymbolicLink() || !runtimeStat.isFile()) {
        throw new Error("运行时描述必须是不含符号链接的普通文件");
      }
      const runtime = RuntimeDescriptorSchema.parse(
        JSON.parse(readFileSync(runtimePath, "utf8")) as unknown,
      );
      const adminUrl = new URL(runtime.localAdminBaseUrl);
      if (
        adminUrl.protocol !== "http:" ||
        adminUrl.hostname !== config.LARK_TASKBOARD_ADMIN_HOST ||
        Number(adminUrl.port || 80) !== config.LARK_TASKBOARD_ADMIN_PORT ||
        adminUrl.username ||
        adminUrl.password ||
        adminUrl.href !== `${adminUrl.origin}/`
      ) {
        throw new Error("运行时管理地址与本机配置不一致");
      }
      if (!requestedDestination) {
        let response: Response | undefined;
        try {
          response = await (dependencies.fetch ?? fetch)(
            new URL("/api/v1/local/backups", adminUrl),
            {
              method: "POST",
              headers: { Authorization: `Bearer ${runtime.capabilityToken}` },
              signal: AbortSignal.timeout(2_000),
            },
          );
        } catch {
          // A crashed process can leave a valid descriptor behind. Continue to
          // the kernel-backed data lock; success proves there is no live owner.
        }
        if (response) {
          if (!response.ok) throw new Error(`在线备份请求失败（HTTP ${response.status}）`);
          const result = OnlineBackupResponseSchema.parse(await response.json());
          emit(output, {
            ok: true,
            command,
            mode: "online",
            backupId: result.data.backupId,
            directory: join(config.LARK_TASKBOARD_DATA_DIR, "backups", result.data.backupId),
            schemaVersion: result.data.manifest.schemaVersion,
            attachmentCount: result.data.manifest.attachments.length,
          });
          return 0;
        }
      }
    }

    const databasePath = join(config.LARK_TASKBOARD_DATA_DIR, "taskboard.sqlite");
    if (!existsSync(databasePath)) throw new Error("数据库不存在，无法备份");
    const dataLock = acquireDataDirectoryLock(config.LARK_TASKBOARD_DATA_DIR, "backup");
    let database: ReturnType<typeof openDatabase> | undefined;
    try {
      database = openDatabase(databasePath);
      const service = new BackupService({
        database,
        dataDirectory: config.LARK_TASKBOARD_DATA_DIR,
      });
      const destination = requestedDestination ?? service.automaticDestination();
      const manifest = await service.create(destination);
      emit(output, {
        ok: true,
        command,
        directory: resolve(destination),
        schemaVersion: manifest.schemaVersion,
        attachmentCount: manifest.attachments.length,
      });
      return 0;
    } finally {
      database?.close();
      dataLock.release();
    }
  } catch (error: unknown) {
    emit(output, {
      ok: false,
      code: "OPERATIONS_FAILED",
      message: error instanceof Error ? error.message : "运维命令失败",
    });
    return 1;
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  process.exitCode = await runOperations(process.argv.slice(2));
}
