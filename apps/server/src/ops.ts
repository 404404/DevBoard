import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { readIdentityAudit } from "./modules/identity/index.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

import { BackupManifestSchema, RuntimeDescriptorSchema } from "@codexboard/contracts";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { openDatabase } from "./modules/database/index.js";
import { acquireDataDirectoryLock, BackupService } from "./modules/operations/index.js";

type Output = (line: string) => void;

const ONLINE_BACKUP_TIMEOUT_MS = 30_000;

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

const WebAccountsResponseSchema = z
  .object({
    data: z.array(
      z.object({
        id: z.uuid(),
        username: z.string(),
        name: z.string(),
        active: z.number().int().min(0).max(1),
      }),
    ),
  })
  .strict();

const WebAccountResponseSchema = z
  .object({
    data: z.object({
      id: z.uuid(),
      username: z.string(),
      name: z.string(),
      active: z.number().int().min(0).max(1),
    }),
  })
  .strict();

export interface OperationsDependencies {
  readonly fetch?: typeof fetch;
  readonly readSecret?: (prompt: string) => Promise<string>;
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

function readAdminRuntime(config: ReturnType<typeof loadConfig>) {
  const runtimePath = join(config.CODEXBOARD_DATA_DIR, "run", "runtime.json");
  if (!existsSync(runtimePath)) return null;
  const runtimeStat = lstatSync(runtimePath);
  if (runtimeStat.isSymbolicLink() || !runtimeStat.isFile())
    throw new Error("运行时描述必须是不含符号链接的普通文件");
  const runtime = RuntimeDescriptorSchema.parse(
    JSON.parse(readFileSync(runtimePath, "utf8")) as unknown,
  );
  const adminUrl = new URL(runtime.localAdminBaseUrl);
  if (
    adminUrl.protocol !== "http:" ||
    adminUrl.hostname !== config.CODEXBOARD_ADMIN_HOST ||
    Number(adminUrl.port || 80) !== config.CODEXBOARD_ADMIN_PORT ||
    adminUrl.username ||
    adminUrl.password ||
    adminUrl.href !== `${adminUrl.origin}/`
  ) {
    throw new Error("运行时管理地址与本机配置不一致");
  }
  return { runtime, adminUrl };
}

async function readSecretFromTerminal(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("密码必须通过交互式 TTY 输入；不要将密码放入参数或环境变量");
  }
  return new Promise((resolveSecret, rejectSecret) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    const wasRaw = input.isRaw;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.setRawMode(wasRaw ?? false);
      input.pause();
      process.stderr.write("\n");
    };
    const onEnd = () => {
      cleanup();
      rejectSecret(new Error("密码输入流已关闭"));
    };
    const onData = (chunk: Buffer | string) => {
      const text = decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      for (const character of text) {
        if (character === "\u0003" || character === "\u0004") {
          cleanup();
          rejectSecret(new Error("密码输入已取消"));
          break;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolveSecret(value);
          break;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (character >= " ") {
          if (value.length >= 256) {
            cleanup();
            rejectSecret(new Error("密码不能超过 256 个字符"));
            break;
          }
          value += character;
        }
      }
    };
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    input.once("end", onEnd);
  });
}

async function webAccountOperation(
  arguments_: readonly string[],
  config: ReturnType<typeof loadConfig>,
  output: Output,
  dependencies: OperationsDependencies,
): Promise<number> {
  const [, action, ...options] = arguments_;
  if (!action || !["list", "create", "enable", "disable", "reset-password"].includes(action)) {
    emit(output, {
      ok: false,
      code: "USAGE_ERROR",
      message:
        "用法：ops web-account list | create --username NAME --name DISPLAY | enable ID | disable ID | reset-password ID",
    });
    return 2;
  }
  const context = readAdminRuntime(config);
  if (!context) {
    throw new Error("服务未运行或 runtime descriptor 不存在；请先启动 DevBoard 容器");
  }
  const fetcher = dependencies.fetch ?? fetch;
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetcher(new URL(path, context.adminUrl), {
      method,
      headers: {
        Authorization: `Bearer ${context.runtime.capabilityToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`本机账号管理请求失败（HTTP ${response.status}）`);
    }
    return response.json() as Promise<unknown>;
  };

  if (action === "list") {
    const result = WebAccountsResponseSchema.parse(
      await request("/api/v1/local/web-accounts", "GET"),
    );
    emit(output, { ok: true, command: "web-account", action, accounts: result.data });
    return 0;
  }

  if (action === "create") {
    const username = optionValue(options, "--username");
    const name = optionValue(options, "--name");
    if (!username || !name) throw new Error("create 需要 --username 和 --name");
    const readSecret = dependencies.readSecret ?? readSecretFromTerminal;
    const password = await readSecret("新 Web 密码（输入不回显）：");
    const confirmation = await readSecret("再次输入密码确认（输入不回显）：");
    if (password !== confirmation) throw new Error("两次密码不一致，未创建账号");
    const result = WebAccountResponseSchema.parse(
      await request("/api/v1/local/web-accounts", "POST", { username, name, password }),
    );
    emit(output, { ok: true, command: "web-account", action, account: result.data });
    return 0;
  }

  if (action === "reset-password") {
    const id = z.uuid().parse(options[0]);
    const readSecret = dependencies.readSecret ?? readSecretFromTerminal;
    const password = await readSecret("新 Web 密码（输入不回显）：");
    const confirmation = await readSecret("再次输入密码确认（输入不回显）：");
    if (password !== confirmation) throw new Error("两次密码不一致，未重置密码");
    await request(`/api/v1/local/web-accounts/${encodeURIComponent(id)}`, "PATCH", { password });
    emit(output, { ok: true, command: "web-account", action, id });
    return 0;
  }

  const id = z.uuid().parse(options[0]);
  await request(`/api/v1/local/web-accounts/${encodeURIComponent(id)}`, "PATCH", {
    active: action === "enable",
  });
  emit(output, { ok: true, command: "web-account", action, id });
  return 0;
}

export async function runOperations(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  output: Output = (line) => process.stdout.write(`${line}\n`),
  dependencies: OperationsDependencies = {},
): Promise<number> {
  const [command, target] = arguments_;
  if (
    !command ||
    !["backup", "verify", "restore", "audit-identities", "web-account"].includes(command)
  ) {
    emit(output, {
      ok: false,
      code: "USAGE_ERROR",
      message:
        "用法：ops backup [--output DIR] | verify DIR | restore DIR | audit-identities DIR | web-account list/create/enable/disable/reset-password",
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
    if (command === "web-account")
      return await webAccountOperation(arguments_, config, output, dependencies);
    if (command === "restore") {
      if (!target) throw new Error("restore 缺少备份目录");
      const result = await BackupService.restore(target, config.CODEXBOARD_DATA_DIR);
      emit(output, { ok: true, command, ...result });
      return 0;
    }

    const requestedDestination = optionValue(arguments_, "--output");
    const context = readAdminRuntime(config);
    if (context) {
      if (!requestedDestination) {
        let response: Response | undefined;
        try {
          response = await (dependencies.fetch ?? fetch)(
            new URL("/api/v1/local/backups", context.adminUrl),
            {
              method: "POST",
              headers: { Authorization: `Bearer ${context.runtime.capabilityToken}` },
              signal: AbortSignal.timeout(ONLINE_BACKUP_TIMEOUT_MS),
            },
          );
        } catch {
          // A crashed process can leave a valid descriptor behind. Continue to
          // the kernel-backed data lock; success proves there is no live owner.
        }
        if (response) {
          if (!response.ok) {
            throw new Error(`在线备份请求失败（HTTP ${response.status}）`);
          }
          const result = OnlineBackupResponseSchema.parse(await response.json());
          emit(output, {
            ok: true,
            command,
            mode: "online",
            backupId: result.data.backupId,
            directory: join(config.CODEXBOARD_DATA_DIR, "backups", result.data.backupId),
            schemaVersion: result.data.manifest.schemaVersion,
            attachmentCount: result.data.manifest.attachments.length,
          });
          return 0;
        }
      }
    }

    const databasePath = join(config.CODEXBOARD_DATA_DIR, "taskboard.sqlite");
    if (!existsSync(databasePath)) throw new Error("数据库不存在，无法备份");
    const dataLock = acquireDataDirectoryLock(config.CODEXBOARD_DATA_DIR, "backup");
    let database: ReturnType<typeof openDatabase> | undefined;
    try {
      database = openDatabase(databasePath);
      const service = new BackupService({
        database,
        dataDirectory: config.CODEXBOARD_DATA_DIR,
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
