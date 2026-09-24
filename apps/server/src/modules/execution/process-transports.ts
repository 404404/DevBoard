import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import type { CodexTransport, JsonRpcMessage } from "../codex/protocol.js";
import { JsonlStreamTransport } from "../codex/transports.js";

const execFileAsync = promisify(execFile);

export interface ProcessTransportOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly description?: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ProcessTransport extends CodexTransport {
  readonly description: string;
  onStderr(listener: (chunk: string) => void): () => void;
  onExit(listener: (exit: ProcessExit) => void): () => void;
  cancel(): Promise<void>;
}

function assertSafeExecutable(executable: string): void {
  if (
    !executable ||
    executable.includes(String.fromCharCode(0)) ||
    executable.includes(String.fromCharCode(10)) ||
    executable.includes(String.fromCharCode(13))
  ) {
    throw new Error("执行文件路径无效");
  }
}

function assertAbsoluteCwd(cwd: string | undefined): void {
  if (
    cwd !== undefined &&
    (!isAbsolute(cwd) ||
      cwd.includes(String.fromCharCode(0)) ||
      cwd.includes(String.fromCharCode(10)) ||
      cwd.includes(String.fromCharCode(13)))
  ) {
    throw new Error("进程工作目录必须是绝对路径");
  }
}

export class ChildProcessTransport implements ProcessTransport {
  readonly description: string;
  readonly #options: ProcessTransportOptions;
  readonly #startupTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #stderrListeners = new Set<(chunk: string) => void>();
  readonly #exitListeners = new Set<(exit: ProcessExit) => void>();
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #jsonl: JsonlStreamTransport | undefined;
  #connected = false;
  #closed = false;
  #exit: ProcessExit | undefined;

  constructor(options: ProcessTransportOptions) {
    assertSafeExecutable(options.executable);
    assertAbsoluteCwd(options.cwd);
    this.#options = options;
    this.description = options.description ?? "child-process";
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("process transport is closed");
    if (this.#connected && this.#process) return;
    const environment = { ...process.env, ...this.#options.env };
    const child = spawn(this.#options.executable, [...(this.#options.args ?? [])], {
      cwd: this.#options.cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", this.#onStderr);
    child.on("exit", this.#onExit);
    const jsonl = new JsonlStreamTransport({
      input: child.stdout,
      output: child.stdin,
      closeStreams: false,
      description: this.description,
    });
    this.#jsonl = jsonl;
    for (const listener of this.#messageListeners) jsonl.onMessage(listener);
    for (const listener of this.#closeListeners) jsonl.onClose(listener);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        child.kill("SIGTERM");
        reject(new Error("进程启动超时"));
      }, this.#startupTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    await jsonl.connect();
    this.#connected = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.#jsonl || !this.#connected) throw new Error("process transport is not connected");
    await this.#jsonl.send(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    const remove = this.#jsonl?.onMessage(listener);
    return () => {
      this.#messageListeners.delete(listener);
      remove?.();
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    const remove = this.#jsonl?.onClose(listener);
    return () => {
      this.#closeListeners.delete(listener);
      remove?.();
    };
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.#stderrListeners.add(listener);
    return () => this.#stderrListeners.delete(listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  async cancel(): Promise<void> {
    const child = this.#process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGINT");
    await this.#waitForExit(this.#shutdownTimeoutMs);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#process;
    await this.#jsonl?.close();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await this.#waitForExit(this.#shutdownTimeoutMs);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  readonly #onStderr = (chunk: string | Buffer): void => {
    const value = chunk.toString();
    for (const listener of this.#stderrListeners) listener(value);
  };

  readonly #onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.#connected = false;
    this.#exit = { code, signal };
    const exit = this.#exit;
    if (!this.#closed) {
      const error = new Error(
        `进程 ${this.description} 异常退出（code=${String(code)}, signal=${String(signal)}）`,
      );
      for (const listener of this.#closeListeners) listener(error);
    }
    for (const listener of this.#exitListeners) listener(exit);
  };

  async #waitForExit(timeoutMs: number): Promise<void> {
    if (this.#exit) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const listener = () => {
        clearTimeout(timer);
        this.#exitListeners.delete(listener);
        resolve();
      };
      this.#exitListeners.add(listener);
    });
  }
}

export interface SshProcessTransportOptions {
  readonly host: string;
  readonly username?: string | null;
  readonly port?: number | null;
  readonly identity?: string | null;
  readonly authMode?: "identity_file" | "agent";
  readonly knownHostsFile?: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly sshExecutable?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

function validateSshToken(value: string): string {
  if (
    !value ||
    value.includes(String.fromCharCode(0)) ||
    value.includes(String.fromCharCode(10)) ||
    value.includes(String.fromCharCode(13)) ||
    value.startsWith("-")
  ) {
    throw new Error("SSH token contains an invalid value");
  }
  return value;
}

/** POSIX shell quoting for one remote argument. It never interpolates raw user text. */
export function quotePosixShell(value: string): string {
  if (value.includes(String.fromCharCode(0))) throw new Error("远程命令参数包含无效字符");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function buildSshRemoteCommand(
  cwd: string,
  executable: string,
  args: readonly string[] = [],
): string {
  if (!isAbsolute(cwd)) throw new Error("SSH 远程工作目录必须是绝对路径");
  validateSshToken(executable);
  return [
    "cd",
    quotePosixShell(cwd),
    "&&",
    "exec",
    quotePosixShell(executable),
    ...args.map((argument) => quotePosixShell(argument)),
  ].join(" ");
}

export function buildSshArguments(options: SshProcessTransportOptions): readonly string[] {
  const host = validateSshToken(options.host);
  const destination = options.username ? `${validateSshToken(options.username)}@${host}` : host;
  const knownHostsFile = options.knownHostsFile ?? "/var/lib/devboard/ssh/known_hosts";
  if (!isAbsolute(knownHostsFile)) throw new Error("SSH known_hosts 路径必须是绝对路径");
  const args: string[] = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (options.port !== null && options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535)
      throw new Error("SSH 端口无效");
    args.push("-p", String(options.port));
  }
  if (options.identity) {
    const identity = validateSshToken(options.identity);
    if (!isAbsolute(identity)) throw new Error("SSH identity 必须是绝对路径");
    args.push("-i", identity);
    args.push("-o", "IdentitiesOnly=yes");
  }
  if (options.authMode === "identity_file" && !options.identity) {
    throw new Error("SSH Identity File must be resolved by the Identity Registry");
  }
  args.push(
    "--",
    destination,
    buildSshRemoteCommand(options.cwd, options.executable, options.args),
  );
  return args;
}

export class SSHProcessTransport extends ChildProcessTransport {
  constructor(options: SshProcessTransportOptions) {
    super({
      executable: options.sshExecutable ?? "ssh",
      args: buildSshArguments(options),
      description: `ssh-process:${options.host}`,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    });
  }
}

export async function runProcessCommand(
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  assertSafeExecutable(executable);
  assertAbsoluteCwd(options.cwd);
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
      exitCode: 0,
    };
  } catch (error: unknown) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
    return {
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

export function readStderr(stream: Readable, listener: (chunk: string) => void): () => void {
  stream.setEncoding("utf8");
  stream.on("data", listener);
  return () => stream.off("data", listener);
}
