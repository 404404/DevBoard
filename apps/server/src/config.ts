import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";
import { isIP } from "node:net";
import { normalizeLarkCodexEnvironment } from "@lark-codex/contracts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const CANONICAL_IPV4_HTTP_ORIGIN =
  /^http:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?::([1-9]\d{0,4}))?$/;

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return false;
  }
  const [first = 0, second = 0, third = 0] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  ) {
    return false;
  }
  return true;
}

function isPublicHttpOrigin(origin: string): boolean {
  const domain = /^http:\/\/([a-zA-Z0-9.-]+)(?::([1-9]\d{0,4}))?$/.exec(origin);
  if (
    domain &&
    domain[1] &&
    !isIP(new URL(origin).hostname) &&
    /[a-z]/i.test(domain[1].split(".").at(-1) || "") &&
    domain[1].length <= 253 &&
    domain[1].includes(".") &&
    domain[1].split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    Number(domain[2] || 80) <= 65535
  )
    return true;
  const match = CANONICAL_IPV4_HTTP_ORIGIN.exec(origin);
  if (!match) return false;
  const port = match[2] ? Number(match[2]) : 80;
  return port <= 65_535 && isPublicIpv4(match[1] ?? "");
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  const parsed = new URL(origin);
  return parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
}

const AppConfigSchema = z
  .object({
    LARK_CODEX_ENV: z.enum(["development", "test", "production"]).default("development"),
    LARK_CODEX_AUTH_MODE: z.enum(["development", "feishu", "web"]).default("development"),
    LARK_CODEX_HOST: z.string().min(1).default("127.0.0.1"),
    LARK_CODEX_PORT: z.coerce.number().int().min(1).max(65_535).default(47_823),
    LARK_CODEX_ADMIN_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
    LARK_CODEX_ADMIN_PORT: z.coerce.number().int().min(1).max(65_535).default(47_824),
    LARK_CODEX_ORIGIN: z.url().default("http://localhost:5173"),
    LARK_CODEX_ALLOWED_HOSTS: z
      .string()
      .default("127.0.0.1:47823,localhost:47823")
      .transform((hosts) =>
        [...new Set(hosts.split(",").map((host) => host.trim().toLowerCase()))].filter(Boolean),
      )
      .pipe(z.array(z.string().min(1)).min(1)),
    LARK_CODEX_DATA_DIR: z
      .string()
      .trim()
      .min(1)
      .default(".data")
      .transform((directory) => resolve(REPOSITORY_ROOT, directory)),
    LARK_CODEX_WORKSPACE_ROOTS: z
      .string()
      .default(dirname(REPOSITORY_ROOT))
      .transform((roots) =>
        [...new Set(roots.split(",").map((root) => root.trim()))].filter(Boolean),
      )
      .pipe(
        z
          .array(z.string().min(1))
          .min(1)
          .refine((roots) => roots.every((root) => isAbsolute(root)), {
            message: "允许的工作区根目录必须全部使用绝对路径",
          }),
      ),
    LARK_CODEX_TEMPORARY_PROJECT_ROOT: z
      .string()
      .trim()
      .default("")
      .refine((path) => path === "" || isAbsolute(path), "临时项目展示目录必须使用绝对路径"),
    LARK_CODEX_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    LARK_CODEX_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
    LARK_CODEX_EVENT_HISTORY_LIMIT: z.coerce.number().int().min(10).max(1_000_000).default(10_000),
    LARK_CODEX_SSE_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    LARK_CODEX_SSE_RETRY_MS: z.coerce.number().int().min(1_000).max(60_000).default(3_000),
    LARK_CODEX_SSE_WRITE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    LARK_CODEX_FEISHU_APP_ID: z.string().trim().min(1).optional(),
    LARK_CODEX_FEISHU_APP_SECRET: z.string().trim().min(1).optional(),
    LARK_CODEX_FEISHU_CREDENTIALS_FILE: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, "飞书凭据文件必须使用绝对路径")
      .optional(),
    LARK_CODEX_FEISHU_APP_SECRET_FILE: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, "飞书 App Secret 文件必须使用绝对路径")
      .optional(),
    LARK_CODEX_FEISHU_API_BASE_URL: z.url().default("https://open.feishu.cn"),
    // Paths as seen by the Codex executor (which may run outside this container).
    LARK_CODEX_EXECUTOR_NODE_PATH: z.string().trim().min(1).refine(isAbsolute).optional(),
    LARK_CODEX_EXECUTOR_TASKCTL_PATH: z.string().trim().min(1).refine(isAbsolute).optional(),
    LARK_CODEX_EXECUTOR_DATA_DIR: z.string().trim().min(1).refine(isAbsolute).optional(),
    LARK_CODEX_CODEX_COMMAND: z.string().trim().min(1).default("codex"),
    LARK_CODEX_CODEX_TRANSPORT: z
      .enum(["managed-unix", "websocket", "embedded"])
      .default("managed-unix"),
    LARK_CODEX_CODEX_ENDPOINT: z
      .url()
      .default("ws://127.0.0.1:47825")
      .transform((endpoint, context) => {
        try {
          return new URL(endpoint).toString();
        } catch {
          context.addIssue({ code: "custom", message: "Codex Endpoint URL 无效" });
          return z.NEVER;
        }
      }),
    LARK_CODEX_CODEX_TOKEN_FILE: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, "Codex capability token 文件必须使用绝对路径")
      .optional(),
    LARK_CODEX_CODEX_PROJECT_STATE_FILE: z.string().trim().min(1).refine(isAbsolute).optional(),
    LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE: z
      .string()
      .trim()
      .default("")
      .refine((path) => path === "" || isAbsolute(path), "Codex 项目快照文件必须使用绝对路径"),
    LARK_CODEX_PROJECT_SYNC_RECONCILE_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(300_000)
      .default(30_000),
    LARK_CODEX_ATTACHMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(100 * 1024 * 1024)
      .default(25 * 1024 * 1024),
    LARK_CODEX_WEB_ROOT: z
      .string()
      .trim()
      .min(1)
      .default(join(REPOSITORY_ROOT, "apps/web/dist"))
      .transform((directory) => resolve(REPOSITORY_ROOT, directory)),
  })
  .superRefine((config, context) => {
    if (config.LARK_CODEX_HOST !== "127.0.0.1") {
      context.addIssue({
        code: "custom",
        path: ["LARK_CODEX_HOST"],
        message: "业务监听地址必须是本机回环地址",
      });
    }

    if (
      config.LARK_CODEX_HOST === config.LARK_CODEX_ADMIN_HOST &&
      config.LARK_CODEX_PORT === config.LARK_CODEX_ADMIN_PORT
    ) {
      context.addIssue({
        code: "custom",
        path: ["LARK_CODEX_ADMIN_PORT"],
        message: "本机管理端口不能与业务端口相同",
      });
    }

    if (
      config.LARK_CODEX_FEISHU_CREDENTIALS_FILE &&
      (config.LARK_CODEX_FEISHU_APP_ID ||
        config.LARK_CODEX_FEISHU_APP_SECRET ||
        config.LARK_CODEX_FEISHU_APP_SECRET_FILE)
    ) {
      context.addIssue({
        code: "custom",
        path: ["LARK_CODEX_FEISHU_CREDENTIALS_FILE"],
        message: "统一飞书凭据文件不能与单独的 App ID、App Secret 或 Secret 文件同时配置",
      });
    }

    if (
      config.LARK_CODEX_AUTH_MODE === "web" &&
      new URL(config.LARK_CODEX_ORIGIN).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        path: ["LARK_CODEX_ORIGIN"],
        message: "Web 账号访问必须使用 HTTPS",
      });
    }
    if (config.LARK_CODEX_AUTH_MODE === "feishu") {
      if (!config.LARK_CODEX_FEISHU_APP_ID && !config.LARK_CODEX_FEISHU_CREDENTIALS_FILE) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_FEISHU_APP_ID"],
          message: "飞书认证模式需要 App ID",
        });
      }
      if (
        !config.LARK_CODEX_FEISHU_APP_SECRET &&
        !config.LARK_CODEX_FEISHU_APP_SECRET_FILE &&
        !config.LARK_CODEX_FEISHU_CREDENTIALS_FILE
      ) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_FEISHU_APP_SECRET"],
          message: "飞书认证模式需要 App Secret",
        });
      }
      if (
        new URL(config.LARK_CODEX_ORIGIN).protocol !== "https:" &&
        !isPublicHttpOrigin(config.LARK_CODEX_ORIGIN)
      ) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_ORIGIN"],
          message: "飞书认证模式必须使用 HTTPS Origin 或公网域名或规范公网 IPv4 HTTP Origin",
        });
      }
    }

    if (
      config.LARK_CODEX_AUTH_MODE === "development" &&
      (config.LARK_CODEX_ENV === "production" ||
        !isLocalDevelopmentOrigin(config.LARK_CODEX_ORIGIN))
    ) {
      context.addIssue({
        code: "custom",
        path: ["LARK_CODEX_AUTH_MODE"],
        message: "开发身份适配器只能用于 localhost HTTP 开发环境",
      });
    }

    if (config.LARK_CODEX_CODEX_TRANSPORT === "embedded") {
      if (!isAbsolute(config.LARK_CODEX_CODEX_COMMAND)) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_CODEX_COMMAND"],
          message: "内嵌桥接需要 Codex 程序的绝对路径",
        });
      }
      if (!config.LARK_CODEX_CODEX_PROJECT_STATE_FILE) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_CODEX_PROJECT_STATE_FILE"],
          message: "内嵌桥接需要 Codex 项目状态文件",
        });
      }
    }

    if (config.LARK_CODEX_CODEX_TRANSPORT !== "managed-unix") {
      const endpoint = URL.parse(config.LARK_CODEX_CODEX_ENDPOINT);
      if (!endpoint) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_CODEX_ENDPOINT"],
          message: "Codex Endpoint URL 无效",
        });
        return;
      }
      const port = Number(endpoint.port || 80);
      if (
        endpoint.protocol !== "ws:" ||
        endpoint.hostname !== "127.0.0.1" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        endpoint.username ||
        endpoint.password ||
        endpoint.href !== `${endpoint.origin}/`
      ) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_CODEX_ENDPOINT"],
          message: "Codex Endpoint 必须是 ws://127.0.0.1:<1-65535>，不能包含凭据、路径、查询或片段",
        });
      }
      if (!config.LARK_CODEX_CODEX_TOKEN_FILE) {
        context.addIssue({
          code: "custom",
          path: ["LARK_CODEX_CODEX_TOKEN_FILE"],
          message: "外部 Codex WebSocket 需要 capability token 文件",
        });
      }
    }

    if (
      config.LARK_CODEX_ENV === "production" &&
      config.LARK_CODEX_CODEX_TRANSPORT === "managed-unix"
    ) {
      context.addIssue({
        code: "custom",
        path: ["LARK_CODEX_CODEX_TRANSPORT"],
        message: "生产环境必须使用受鉴权保护的外部或内嵌 Codex 桥接",
      });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type LogLevel = AppConfig["LARK_CODEX_LOG_LEVEL"];

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("服务配置无效");
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = AppConfigSchema.safeParse(normalizeLarkCodexEnvironment(environment));

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const config = result.data;
  if (isPublicHttpOrigin(config.LARK_CODEX_ORIGIN)) {
    config.LARK_CODEX_ORIGIN = new URL(config.LARK_CODEX_ORIGIN).origin;
  }
  if (!config.LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE) {
    config.LARK_CODEX_CODEX_PROJECT_SNAPSHOT_FILE = join(
      config.LARK_CODEX_DATA_DIR,
      "run",
      "codex-projects.json",
    );
  }
  if (!config.LARK_CODEX_TEMPORARY_PROJECT_ROOT && process.platform === "darwin") {
    config.LARK_CODEX_TEMPORARY_PROJECT_ROOT = join(homedir(), "Documents", "Codex");
  }
  if (config.LARK_CODEX_FEISHU_APP_SECRET && config.LARK_CODEX_FEISHU_APP_SECRET_FILE) {
    throw new ConfigError([
      "LARK_CODEX_FEISHU_APP_SECRET_FILE: 不能同时配置明文 Secret 与 Secret 文件",
    ]);
  }
  if (config.LARK_CODEX_FEISHU_CREDENTIALS_FILE) {
    const path = config.LARK_CODEX_FEISHU_CREDENTIALS_FILE;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("凭据文件必须是权限不宽于 0600 的普通文件");
      }
      const credentials = z
        .strictObject({
          appId: z
            .string()
            .trim()
            .regex(/^cli_[A-Za-z0-9]+$/),
          appSecret: z
            .string()
            .trim()
            .min(1)
            .regex(/^[^\r\n\0]+$/),
        })
        .parse(JSON.parse(readFileSync(path, "utf8")));
      config.LARK_CODEX_FEISHU_APP_ID = credentials.appId;
      config.LARK_CODEX_FEISHU_APP_SECRET = credentials.appSecret;
    } catch {
      // JSON 解析异常可能包含凭据片段，只报告固定错误。
      throw new ConfigError([
        "LARK_CODEX_FEISHU_CREDENTIALS_FILE: 无法读取有效凭据，请检查文件为权限不宽于 0600 的普通文件，且 JSON 包含有效的 appId、appSecret",
      ]);
    }
  }
  if (config.LARK_CODEX_FEISHU_APP_SECRET_FILE) {
    const path = config.LARK_CODEX_FEISHU_APP_SECRET_FILE;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("文件必须是权限 0600 的普通文件");
      }
      const secret = readFileSync(path, "utf8").trim();
      if (!secret) throw new Error("文件内容为空");
      config.LARK_CODEX_FEISHU_APP_SECRET = secret;
    } catch (error: unknown) {
      throw new ConfigError([
        `LARK_CODEX_FEISHU_APP_SECRET_FILE: ${error instanceof Error ? error.message : "无法读取"}`,
      ]);
    }
  }
  if (config.LARK_CODEX_CODEX_TOKEN_FILE) {
    const path = config.LARK_CODEX_CODEX_TOKEN_FILE;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("文件必须是权限不宽于 0600 的普通文件");
      }
      if (!readFileSync(path, "utf8").trim()) throw new Error("文件内容为空");
    } catch (error: unknown) {
      throw new ConfigError([
        `LARK_CODEX_CODEX_TOKEN_FILE: ${error instanceof Error ? error.message : "无法读取"}`,
      ]);
    }
  }
  if (config.LARK_CODEX_ENV === "production") {
    const indexPath = join(config.LARK_CODEX_WEB_ROOT, "index.html");
    if (!existsSync(indexPath) || !lstatSync(indexPath).isFile()) {
      throw new ConfigError(["LARK_CODEX_WEB_ROOT: Web 构建目录缺少 index.html"]);
    }
  }
  return config;
}
