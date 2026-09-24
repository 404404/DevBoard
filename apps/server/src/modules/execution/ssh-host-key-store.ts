import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { AppError } from "../../app-error.js";

const execFileAsync = promisify(execFile);
const CANDIDATE_TTL_MS = 5 * 60_000;

export interface SSHHostKeyTarget {
  readonly id: string;
  readonly host: string | null;
  readonly port: number | null;
}

export interface SSHHostKeyView {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly trusted: boolean;
}

interface Candidate extends SSHHostKeyView {
  readonly targetId: string;
  readonly hostEntry: string;
  readonly keyData: string;
  readonly expiresAt: number;
}

function hostEntry(target: SSHHostKeyTarget): string {
  if (!target.host || !/^[A-Za-z0-9._:-]+$/.test(target.host) || target.host.startsWith("-")) {
    throw new AppError("INVALID_REQUEST", 400, "SSH Host 格式无效");
  }
  const port = target.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError("INVALID_REQUEST", 400, "SSH 端口无效");
  }
  return port === 22 ? target.host : `[${target.host}]:${port}`;
}

function fingerprint(keyData: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(keyData, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function openManagedFile(file: string, flags: number, mode?: number): number {
  try {
    const parent = lstatSync(dirname(file));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error("invalid parent");
    }
    const descriptor = openSync(file, flags | constants.O_NOFOLLOW, mode);
    if (!fstatSync(descriptor).isFile()) {
      closeSync(descriptor);
      throw new Error("not a regular file");
    }
    return descriptor;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new AppError("HOST_KEY_FAILED", 500, "DevBoard managed known_hosts 必须是受控普通文件", {
      cause: error,
    });
  }
}

function readEntries(
  file: string,
  host: string,
): readonly { algorithm: string; keyData: string }[] {
  let descriptor: number;
  try {
    descriptor = openManagedFile(file, constants.O_RDONLY);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
  let content: string;
  try {
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[0]?.split(",").includes(host))
    .map((parts) => ({ algorithm: parts[1] ?? "", keyData: parts[2] ?? "" }));
}

export class SSHHostKeyStore {
  readonly #file: string;
  readonly #scanner: string;
  readonly #candidates = new Map<string, Candidate>();

  constructor(file: string, scanner = "ssh-keyscan") {
    this.#file = file;
    this.#scanner = scanner;
  }

  async scan(target: SSHHostKeyTarget): Promise<readonly SSHHostKeyView[]> {
    if (!target.host) throw new AppError("INVALID_REQUEST", 400, "请先配置 SSH Host");
    const entry = hostEntry(target);
    const args = ["-T", "5"];
    if (target.port !== null) args.push("-p", String(target.port));
    args.push(target.host);
    let stdout: string;
    try {
      const result = await execFileAsync(this.#scanner, args, {
        timeout: 7_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
      stdout = String(result.stdout);
    } catch (error: unknown) {
      const failure = error as { stdout?: unknown };
      stdout = String(failure.stdout ?? "");
    }

    const existing = readEntries(this.#file, entry);
    const found = new Map<string, Candidate>();
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3 || line.startsWith("#")) continue;
      const algorithm = parts[1] ?? "";
      const keyData = parts[2] ?? "";
      if (!/^[A-Za-z0-9@._+-]+$/.test(algorithm) || !/^[A-Za-z0-9+/]+={0,2}$/.test(keyData))
        continue;
      const keyFingerprint = fingerprint(keyData);
      const trusted = existing.some(
        (key) => key.algorithm === algorithm && key.keyData === keyData,
      );
      found.set(keyFingerprint, {
        targetId: target.id,
        hostEntry: entry,
        algorithm,
        keyData,
        fingerprint: keyFingerprint,
        trusted,
        expiresAt: Date.now() + CANDIDATE_TTL_MS,
      });
    }
    for (const candidate of found.values())
      this.#candidates.set(`${target.id}:${candidate.fingerprint}`, candidate);
    return [...found.values()].map(({ algorithm, fingerprint: keyFingerprint, trusted }) => ({
      algorithm,
      fingerprint: keyFingerprint,
      trusted,
    }));
  }

  trust(target: SSHHostKeyTarget, selectedFingerprint: string): SSHHostKeyView {
    const key = `${target.id}:${selectedFingerprint}`;
    const candidate = this.#candidates.get(key);
    if (!candidate || candidate.expiresAt < Date.now()) {
      this.#candidates.delete(key);
      throw new AppError("HOST_KEY_UNTRUSTED", 409, "指纹确认已过期，请重新扫描 SSH Host Key");
    }
    if (candidate.hostEntry !== hostEntry(target)) {
      throw new AppError("INVALID_REQUEST", 409, "SSH Host 配置已变化，请重新扫描 Host Key");
    }

    const existing = readEntries(this.#file, candidate.hostEntry).filter(
      (entry) => entry.algorithm === candidate.algorithm,
    );
    if (existing.length > 0 && !existing.some((entry) => entry.keyData === candidate.keyData)) {
      throw new AppError(
        "HOST_KEY_CHANGED",
        409,
        "该 SSH Host 的同算法密钥与已信任密钥不同；为避免中间人攻击，未覆盖 known_hosts",
      );
    }
    if (existing.length === 0) {
      const descriptor = openManagedFile(
        this.#file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
        0o600,
      );
      try {
        fchmodSync(descriptor, 0o600);
        writeFileSync(
          descriptor,
          `${candidate.hostEntry} ${candidate.algorithm} ${candidate.keyData}\n`,
          { encoding: "utf8" },
        );
      } finally {
        closeSync(descriptor);
      }
    }
    this.#candidates.delete(key);
    return {
      algorithm: candidate.algorithm,
      fingerprint: candidate.fingerprint,
      trusted: true,
    };
  }

  list(target: SSHHostKeyTarget): readonly SSHHostKeyView[] {
    const entry = hostEntry(target);
    return readEntries(this.#file, entry).map((key) => ({
      algorithm: key.algorithm,
      fingerprint: fingerprint(key.keyData),
      trusted: true,
    }));
  }
}
