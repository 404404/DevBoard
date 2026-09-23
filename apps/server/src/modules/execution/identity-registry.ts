import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import type { SshIdentityDescriptor } from "@codexboard/contracts";

import { AppError } from "../../app-error.js";
import { runProcessCommand } from "./process-transports.js";

const SAFE_IDENTITY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Opaque domain reference. It is never a filesystem path or credential value. */
export type SecretReference = string;

export interface ResolvedIdentityFile {
  /** Internal-only path passed to the SSH process; never serialize or log it. */
  readonly path: string;
}

export interface IdentityRegistry {
  list(): Promise<readonly SshIdentityDescriptor[]>;
  resolve(reference: SecretReference): ResolvedIdentityFile;
}

interface PublicIdentityMetadata {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly encrypted: boolean;
}

type IdentityInspector = (path: string) => Promise<PublicIdentityMetadata>;

function validReference(reference: string): boolean {
  return (
    SAFE_IDENTITY_REFERENCE.test(reference) &&
    !reference.includes("..") &&
    !reference.includes("/") &&
    !reference.includes("\\")
  );
}

function descriptor(
  id: string,
  values: Partial<SshIdentityDescriptor> & Pick<SshIdentityDescriptor, "usable">,
): SshIdentityDescriptor {
  return {
    id,
    name: id,
    algorithm: values.algorithm ?? null,
    fingerprint: values.fingerprint ?? null,
    encrypted: values.encrypted ?? null,
    usable: values.usable,
    warning: values.warning ?? null,
  };
}

async function inspectIdentityFile(
  path: string,
  executable: string,
): Promise<PublicIdentityMetadata> {
  try {
    const result = await runKeyInspectionCommand(executable, path);
    const [algorithm, encodedKey] = result.stdout.trim().split(/\s+/);
    if (!algorithm || !encodedKey || !/^[A-Za-z0-9@._+-]{1,100}$/.test(algorithm)) {
      throw new Error("invalid public key output");
    }
    const keyBytes = Buffer.from(encodedKey, "base64");
    if (keyBytes.length === 0) throw new Error("invalid public key blob");
    return {
      algorithm,
      fingerprint: `SHA256:${createHash("sha256")
        .update(keyBytes)
        .digest("base64")
        .replace(/=+$/, "")}`,
      encrypted: false,
    };
  } catch (error: unknown) {
    const failure = error as { stderr?: unknown };
    const diagnostic = String(failure.stderr ?? "");
    if (/(?:incorrect|bad)\s+passphrase|passphrase(?:\s+is)?\s+required/i.test(diagnostic)) {
      return { algorithm: "", fingerprint: "", encrypted: true };
    }
    // ssh-keygen diagnostics can contain paths or key material; never propagate them.
    throw new Error("identity inspection failed");
  }
}

function runKeyInspectionCommand(
  executable: string,
  path: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, ["-y", "-P", "", "-f", path], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => rejectResult(new Error("identity inspection timed out")));
    }, 2_000);
    const collect = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const next = `${target === "stdout" ? stdout : stderr}${chunk.toString()}`;
      if (next.length > 32 * 1024) {
        child.kill("SIGKILL");
        finish(() => rejectResult(new Error("identity inspection output exceeded limit")));
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer | string) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => collect("stderr", chunk));
    child.once("error", () => finish(() => rejectResult(new Error("identity inspection failed"))));
    child.once("close", (code) => {
      if (code === 0) finish(() => resolveResult({ stdout, stderr }));
      else {
        finish(() =>
          rejectResult(Object.assign(new Error("identity inspection failed"), { stderr })),
        );
      }
    });
  });
}

export class DirectoryIdentityRegistry implements IdentityRegistry {
  readonly #directory: string;
  readonly #inspector: IdentityInspector;

  constructor(
    directory: string,
    options: { readonly inspect?: IdentityInspector; readonly sshKeygenExecutable?: string } = {},
  ) {
    if (!isAbsolute(directory)) throw new Error("SSH Identity 目录必须使用绝对路径");
    this.#directory = resolve(directory);
    this.#inspector =
      options.inspect ??
      ((path) => inspectIdentityFile(path, options.sshKeygenExecutable ?? "ssh-keygen"));
  }

  async list(): Promise<readonly SshIdentityDescriptor[]> {
    const directory = this.#readDirectory();
    if (!directory) return [];
    const result: SshIdentityDescriptor[] = [];
    const names = readdirSync(this.#directory).sort((left, right) => left.localeCompare(right));
    for (const id of names) {
      if (!validReference(id)) continue;
      let stat;
      try {
        stat = lstatSync(resolve(this.#directory, id));
      } catch {
        result.push(descriptor(id, { usable: false, warning: "Identity 文件无法读取" }));
        continue;
      }
      if (stat.isSymbolicLink()) {
        result.push(descriptor(id, { usable: false, warning: "不接受 symbolic link" }));
        continue;
      }
      if (!stat.isFile()) {
        result.push(descriptor(id, { usable: false, warning: "Identity 必须是普通文件" }));
        continue;
      }
      const permissionWarning = this.#permissionWarning(resolve(this.#directory, id), stat.mode);
      if (permissionWarning) {
        result.push(descriptor(id, { usable: false, warning: permissionWarning }));
        continue;
      }
      try {
        const metadata = await this.#inspector(resolve(this.#directory, id));
        if (metadata.encrypted) {
          result.push(descriptor(id, {
            usable: false,
            encrypted: true,
            warning: "私钥需要 passphrase；请通过 SSH Agent 加载后使用",
          }));
        } else {
          result.push(descriptor(id, { ...metadata, usable: true }));
        }
      } catch {
        result.push(descriptor(id, {
          usable: false,
          warning: "无法识别为可用的 SSH Identity 文件",
        }));
      }
    }
    return result;
  }

  resolve(reference: SecretReference): ResolvedIdentityFile {
    if (typeof reference !== "string" || !validReference(reference)) {
      throw new AppError(
        "SSH_IDENTITY_INVALID",
        400,
        "Identity 必须从受控 Identity Catalog 中选择",
      );
    }
    if (!this.#readDirectory()) {
      throw new AppError("SSH_IDENTITY_NOT_FOUND", 409, "SSH Identity 目录不存在或不可用");
    }
    const path = resolve(this.#directory, reference);
    if (path === this.#directory || !path.startsWith(`${this.#directory}/`)) {
      throw new AppError("SSH_IDENTITY_INVALID", 400, "Identity 引用无效");
    }
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new AppError("SSH_IDENTITY_NOT_FOUND", 409, "所选 SSH Identity 已不存在");
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AppError(
        "SSH_IDENTITY_INVALID",
        409,
        "Identity 必须是普通文件，且不能是 symbolic link",
      );
    }
    const permissionWarning = this.#permissionWarning(path, stat.mode);
    if (permissionWarning) {
      throw new AppError("SSH_IDENTITY_PERMISSIONS", 409, permissionWarning);
    }
    return { path };
  }

  #readDirectory(): boolean {
    let stat;
    try {
      stat = lstatSync(this.#directory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new AppError("SSH_IDENTITY_INVALID", 500, "SSH Identity 目录不可访问");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AppError(
        "SSH_IDENTITY_INVALID",
        500,
        "SSH Identity 目录必须是实际目录，不能是 symbolic link",
      );
    }
    try {
      accessSync(this.#directory, constants.R_OK | constants.X_OK);
    } catch {
      throw new AppError("SSH_IDENTITY_PERMISSIONS", 500, "SSH Identity 目录不可读");
    }
    return true;
  }

  #permissionWarning(path: string, mode: number): string | null {
    if ((mode & 0o7177) !== 0 || (mode & 0o400) === 0) {
      return "权限不安全：需 owner 可读、group/other 禁止且不得可执行（建议 chmod 600）";
    }
    try {
      accessSync(path, constants.R_OK);
    } catch {
      return "当前 DevBoard 用户无权读取该 Identity 文件";
    }
    return null;
  }
}

export async function isSshAgentAvailable(
  socketPath = process.env.SSH_AUTH_SOCK,
): Promise<boolean> {
  if (!socketPath || !isAbsolute(socketPath)) return false;
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) return false;
    accessSync(socketPath, constants.R_OK | constants.W_OK);
  } catch {
    return false;
  }
  try {
    const result = await runProcessCommand("ssh-add", ["-l", "-E", "sha256"], { timeoutMs: 1_500 });
    return (
      result.exitCode === 0 ||
      /The agent has no identities|agent contains no identities/i.test(
        `${result.stdout}\n${result.stderr}`,
      )
    );
  } catch {
    // A missing ssh-add binary or an unresponsive agent means Agent auth is unavailable.
    // Do not let optional Agent discovery break the Settings API or wait indefinitely.
    return false;
  }
}
