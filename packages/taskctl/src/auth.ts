import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  FeishuIdentityRefSchema,
  normalizeLarkCodexEnvironment,
  type RuntimeDescriptor,
} from "@lark-codex/contracts";

export interface CredentialStore {
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export class TaskctlAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function validateRuntimeTarget(runtime: RuntimeDescriptor): void {
  const local = new URL(runtime.localAdminBaseUrl);
  const publicUrl = new URL(runtime.publicBaseUrl);
  if (
    !["http:", "https:"].includes(local.protocol) ||
    !["127.0.0.1", "[::1]"].includes(local.hostname) ||
    local.username ||
    local.password ||
    local.hash ||
    local.search ||
    local.pathname !== "/" ||
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.hash
  )
    throw new TaskctlAuthError(
      "UNSAFE_RUNTIME_TARGET",
      "runtime 地址无效；凭据只允许发送到本机 loopback 接口",
    );
}
export function runtimeScope(runtime: RuntimeDescriptor): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        new URL(runtime.publicBaseUrl).href,
        new URL(runtime.localAdminBaseUrl).href,
      ]),
    )
    .digest("hex");
}
export function authFileLocations(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): { current: string; legacy?: string } {
  const env = normalizeLarkCodexEnvironment(environment);
  if (env.LARK_CODEX_AUTH_FILE !== undefined) {
    if (!env.LARK_CODEX_AUTH_FILE.trim())
      throw new TaskctlAuthError("CLI_AUTH_FILE_INVALID", "LARK_CODEX_AUTH_FILE 不能为空");
    return { current: env.LARK_CODEX_AUTH_FILE };
  }
  const directory = env.XDG_CONFIG_HOME ?? join(userHome, ".config");
  return {
    current: join(directory, "lark-codex", "taskctl-auth"),
    legacy: join(directory, "lark-taskboard", "taskctl-auth"),
  };
}
export function defaultAuthFile(): string {
  return authFileLocations().current;
}

/** Read only the matching runtime scope from the previous default location.
 * Existing new credentials, including invalid/expired ones, never fall back. */
export function compatibleCredentialStore(
  locations: { current: string; legacy?: string },
  store: CredentialStore = defaultCredentialStore,
): CredentialStore {
  const oldPath = (path: string) => {
    const suffix = path.slice(locations.current.length);
    return locations.legacy &&
      path.startsWith(locations.current) &&
      /^\.[a-f0-9]{64}(?:\.pending)?\.json$/.test(suffix)
      ? `${locations.legacy}${suffix}`
      : undefined;
  };
  return {
    async read(path) {
      const value = await store.read(path);
      if (value !== null) return value;
      const legacy = oldPath(path);
      return legacy ? store.read(legacy) : null;
    },
    write: (path, value) => store.write(path, value),
    async remove(path) {
      const legacy = oldPath(path);
      // Clear legacy first: a failure must not expose it after removing current.
      if (legacy) await store.remove(legacy);
      await store.remove(path);
    },
  };
}
export function credentialPaths(runtime: RuntimeDescriptor, base: string) {
  const scope = runtimeScope(runtime);
  return { scope, session: `${base}.${scope}.json`, pending: `${base}.${scope}.pending.json` };
}
export const defaultCredentialStore: CredentialStore = {
  async read(path) {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          (stat.mode & 0o777) !== 0o600 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new TaskctlAuthError(
            "CLI_AUTH_FILE_PERMISSIONS",
            "CLI 凭据文件必须由当前用户拥有且权限为 0600",
          );
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof TaskctlAuthError) throw error;
      throw new TaskctlAuthError("CLI_AUTH_FILE_READ", "无法安全读取 CLI 凭据文件");
    }
  },
  async write(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(value, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};
const Shared = { scope: z.string(), expiresAt: z.iso.datetime() };
export const PendingCredentialSchema = z
  .object({ ...Shared, requestId: z.string().min(1), claimSecret: z.string().min(1) })
  .strict();
export const SessionCredentialSchema = z
  .object({ ...Shared, token: z.string().min(1), identity: FeishuIdentityRefSchema })
  .strict();
export async function readCredential<T>(
  store: CredentialStore,
  path: string,
  schema: z.ZodType<T>,
  scope: string,
  now: number,
): Promise<T | null> {
  const raw = await store.read(path);
  if (raw === null) return null;
  let result: z.ZodSafeParseResult<T>;
  try {
    result = schema.safeParse(JSON.parse(raw));
  } catch {
    throw new TaskctlAuthError("CLI_AUTH_FILE_INVALID", "CLI 凭据文件无效，请重新登录");
  }
  if (!result.success)
    throw new TaskctlAuthError("CLI_AUTH_FILE_INVALID", "CLI 凭据文件无效，请重新登录");
  const common = result.data as { scope: string; expiresAt: string };
  if (common.scope !== scope)
    throw new TaskctlAuthError(
      "CLI_AUTH_RUNTIME_MISMATCH",
      "CLI 凭据不属于当前 runtime，请重新登录",
    );
  if (Date.parse(common.expiresAt) <= now)
    throw new TaskctlAuthError("CLI_AUTH_EXPIRED", "CLI 凭据已过期，请重新登录");
  return result.data;
}
