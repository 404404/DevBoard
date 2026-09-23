import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import {
  resolveLegacyIdentities,
  IdentityMigrationPreflightError,
} from "./modules/identity/identity-migration-preflight.js";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { appControl, createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { identityMigrations, MigrationError, openDatabase } from "./modules/database/index.js";
import {
  CodexProvider,
  CursorProvider,
  ExecutionProviderRegistry,
  GrokBuildProvider,
  OpenCodeProvider,
} from "./modules/execution/index.js";
import {
  acquireDataDirectoryLock,
  BackgroundBackupRunner,
  BackupService,
  recoverInterruptedRestore,
  runMigrationsWithBackup,
} from "./modules/operations/index.js";
import {
  createRuntimeCapability,
  publishRuntimeDescriptor,
  type RuntimeDescriptorHandle,
} from "./modules/runtime/index.js";
import { safeStartupErrorDetails } from "./startup-error.js";
import { createLocalAdminApp } from "./transports/local-admin-http.js";

interface RunningServers {
  readonly publicApp: FastifyInstance;
  readonly localAdminApp: FastifyInstance;
}

async function startServer(): Promise<RunningServers> {
  const config = loadConfig();
  const dataLock = acquireDataDirectoryLock(config.CODEXBOARD_DATA_DIR, "server");
  let database: ReturnType<typeof openDatabase> | undefined;
  let publicApp: FastifyInstance | undefined;
  let localAdminApp: FastifyInstance | undefined;
  let runtimeDescriptor: RuntimeDescriptorHandle | undefined;
  try {
    mkdirSync(config.CODEXBOARD_DATA_DIR, { recursive: true, mode: 0o700 });
    const sshDirectory = join(config.CODEXBOARD_DATA_DIR, "ssh");
    mkdirSync(sshDirectory, { recursive: true, mode: 0o700 });
    const sshDirectoryStat = lstatSync(sshDirectory);
    if (sshDirectoryStat.isSymbolicLink() || !sshDirectoryStat.isDirectory()) {
      throw new Error("SSH data directory must be a real directory");
    }
    const knownHostsFile = join(sshDirectory, "known_hosts");
    const knownHostsDescriptor = openSync(
      knownHostsFile,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!fstatSync(knownHostsDescriptor).isFile()) {
        throw new Error("known_hosts must be a regular file");
      }
      fchmodSync(knownHostsDescriptor, 0o600);
    } finally {
      closeSync(knownHostsDescriptor);
    }
    if (config.CODEXBOARD_ENV !== "production") {
      for (const workspaceRoot of config.CODEXBOARD_WORKSPACE_ROOTS) {
        mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
      }
    }
    recoverInterruptedRestore(config.CODEXBOARD_DATA_DIR);
    database = openDatabase(join(config.CODEXBOARD_DATA_DIR, "taskboard.sqlite"));
    await runMigrationsWithBackup(
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
    const executionProviders = new ExecutionProviderRegistry();
    executionProviders.register(new CodexProvider());
    executionProviders.register(new CursorProvider());
    executionProviders.register(new GrokBuildProvider());
    executionProviders.register(new OpenCodeProvider());
    const capabilityToken = createRuntimeCapability();
    publicApp = createApp({
      config,
      database,
      logger: true,
      logLevel: config.CODEXBOARD_LOG_LEVEL,
      closeDatabaseOnClose: false,
      executionProviders,
    });
    const control = appControl(publicApp);
    localAdminApp = createLocalAdminApp({
      config,
      database,
      capabilityToken,
      logger: true,
      logLevel: config.CODEXBOARD_LOG_LEVEL,
      scheduleExecution: control.scheduleExecution,
      onRevisionCommitted: control.notifyRevisionCommitted,
      services: control.services,
      backupRunner: new BackgroundBackupRunner(config.CODEXBOARD_DATA_DIR),
    });
    await publicApp.listen({
      host: config.CODEXBOARD_HOST,
      port: config.CODEXBOARD_PORT,
    });
    await localAdminApp.listen({
      host: config.CODEXBOARD_ADMIN_HOST,
      port: config.CODEXBOARD_ADMIN_PORT,
    });
    runtimeDescriptor = publishRuntimeDescriptor(config, capabilityToken);
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (signal: NodeJS.Signals): Promise<void> => {
      shutdownPromise ??= (async () => {
        publicApp?.log.info({ signal }, "Shutting down server");
        await Promise.allSettled([publicApp?.close(), localAdminApp?.close()]);
        runtimeDescriptor?.remove();
        if (database?.open) database.close();
        dataLock.release();
      })();
      return shutdownPromise;
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    publicApp.log.info(
      {
        publicAddress: `${config.CODEXBOARD_HOST}:${config.CODEXBOARD_PORT}`,
        localAdminAddress: `${config.CODEXBOARD_ADMIN_HOST}:${config.CODEXBOARD_ADMIN_PORT}`,
        runtimeDescriptor: runtimeDescriptor.path,
      },
      "Public and local admin listeners are ready",
    );
    return {
      publicApp,
      localAdminApp,
    };
  } catch (error: unknown) {
    await Promise.allSettled([publicApp?.close(), localAdminApp?.close()]);
    runtimeDescriptor?.remove();
    if (database?.open) database.close();
    dataLock.release();
    throw error;
  }
}

try {
  await startServer();
} catch (error: unknown) {
  const code =
    error instanceof IdentityMigrationPreflightError
      ? error.code
      : error instanceof ConfigError
        ? "CONFIG_INVALID"
        : error instanceof MigrationError
          ? "MIGRATION_FAILED"
          : "INTERNAL_ERROR";
  const startupError = {
    level: "error",
    code,
    ...safeStartupErrorDetails(error),
    message:
      error instanceof IdentityMigrationPreflightError
        ? error.message
        : code === "CONFIG_INVALID"
          ? "服务配置无效"
          : code === "MIGRATION_FAILED"
            ? "数据库迁移失败"
            : "服务启动失败",
  };

  process.stderr.write(`${JSON.stringify(startupError)}\n`);
  process.exitCode = 1;
}
