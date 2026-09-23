import {
  type ModelDescriptor,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderKind,
  type RunEventType,
} from "@codexboard/contracts";

import {
  AcpClient,
  AcpProcessSession,
  type AcpPermissionRequest,
  type AcpUpdate,
} from "./acp-client.js";
import {
  buildSshArguments,
  runProcessCommand,
  SSHProcessTransport,
  type ProcessTransport,
} from "./process-transports.js";
import type {
  ExecutionApprovalDecision,
  ExecutionApprovalRequest,
  ExecutionCapabilitiesContext,
  ExecutionCallbacks,
  ExecutionHistory,
  ExecutionInput,
  ExecutionProvider,
  ExecutionResult,
  ExecutionSession,
  ProviderConnectionContext,
} from "./execution-provider.js";
import { isSshAgentAvailable } from "./identity-registry.js";

export interface AcpProviderOptions {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly capabilities: ProviderCapability;
  readonly versionArgs?: readonly string[];
  readonly models?: readonly ModelDescriptor[];
}

function textFromUpdate(update: unknown): string {
  if (typeof update === "string") return update;
  if (!update || typeof update !== "object") return "";
  const value = update as Record<string, unknown>;
  if (typeof value.text === "string") return value.text;
  if (typeof value.delta === "string") return value.delta;
  if (typeof value.message === "string") return value.message;
  const content = value.content;
  if (Array.isArray(content)) {
    return content
      .flatMap((entry) => (entry && typeof entry === "object" ? [String((entry as Record<string, unknown>).text ?? "")] : []))
      .join("");
  }
  return "";
}

function eventType(update: unknown): RunEventType {
  if (!update || typeof update !== "object") return "run.progress";
  const value = update as Record<string, unknown>;
  const kind = String(value.sessionUpdate ?? value.type ?? value.kind ?? "").toLowerCase();
  if (kind.includes("agent") || kind.includes("message")) return "agent.message";
  if (kind.includes("thinking") || kind.includes("reason")) return "agent.thinking";
  if (kind.includes("tool")) return kind.includes("start") ? "tool.started" : "tool.completed";
  if (kind.includes("command")) return kind.includes("start") ? "command.started" : "command.completed";
  if (kind.includes("file") || kind.includes("diff")) return "file.changed";
  return "run.progress";
}

function safeProviderEvent(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (/token|secret|password|credential|authorization|private.?key|api.?key|environment/i.test(key))
      continue;
    if (typeof entry === "string") result[key] = entry.slice(0, 10_000);
    else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) result[key] = entry;
  }
  return result;
}

function mapApproval(request: AcpPermissionRequest): ExecutionApprovalRequest {
  const params =
    request.request.params && typeof request.request.params === "object"
      ? safeProviderEvent(request.request.params)
      : {};
  return {
    requestId: String(request.request.id),
    type: request.request.method,
    summary: "Provider 请求权限确认",
    details: params,
    choices: [],
  };
}

function approvalResult(decision: ExecutionApprovalDecision): unknown {
  if (decision.type === "approve") return { outcome: "approved" };
  if (decision.type === "cancel") return { outcome: "cancelled" };
  if (decision.type === "input") return { outcome: "input", answers: decision.answers };
  return { outcome: "rejected", reason: decision.reason ?? "用户拒绝" };
}

export class AcpProvider implements ExecutionProvider {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly #executable: string;
  readonly #args: readonly string[];
  readonly #capabilities: ProviderCapability;
  readonly #versionArgs: readonly string[];
  readonly #models: readonly ModelDescriptor[];
  readonly #clients = new Map<string, { client: AcpClient; process: ProcessTransport }>();

  constructor(options: AcpProviderOptions) {
    this.kind = options.kind;
    this.displayName = options.displayName;
    this.#executable = options.executable;
    this.#args = options.args;
    this.#capabilities = options.capabilities;
    this.#versionArgs = options.versionArgs ?? ["--version"];
    this.#models = options.models ?? [];
  }

  async capabilities(_context: ExecutionCapabilitiesContext): Promise<ProviderCapability> {
    return this.#capabilities;
  }

  async listModels(_context: ExecutionCapabilitiesContext): Promise<readonly ModelDescriptor[]> {
    return this.#models;
  }

  async health(context: ExecutionCapabilitiesContext): Promise<ProviderHealth> {
    if (!context.connection.host || !context.connection.username) {
      return {
        status: "unknown",
        version: null,
        message: "请先配置 SSH Host 与用户名",
        checkedAt: new Date().toISOString(),
        latencyMs: null,
      };
    }
    if (context.connection.authMode === "agent" && !(await isSshAgentAvailable())) {
      return {
        status: "authentication_required",
        version: null,
        message: "SSH Agent 不可用：请检查可访问的 SSH_AUTH_SOCK socket，或改用 Identity File",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
      };
    }
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    const command = buildSshArguments({
      host: context.connection.host,
      username: context.connection.username,
      port: context.connection.port,
      identity: context.connection.identityFilePath,
      authMode: context.connection.authMode,
      knownHostsFile: context.connection.knownHostsFile,
      executable: this.#executable,
      args: this.#versionArgs,
      cwd: context.workspace ?? "/",
    });
    const result = await runProcessCommand("ssh", command);
    if (result.exitCode !== 0) {
      const output = String(result.stderr) + " " + String(result.stdout);
      const hostKeyChanged = /REMOTE HOST IDENTIFICATION HAS CHANGED|offending key/i.test(output);
      const hostKey = /host key|known_hosts|no .* host key is known/i.test(output);
      const passphrase = /passphrase|incorrect passphrase/i.test(output);
      const authentication = /login|auth|credential|permission denied|unauthorized/i.test(output);
      return {
        status: passphrase ? "key_passphrase_required" : hostKeyChanged ? "host_key_changed" : hostKey ? "host_key_untrusted" : authentication ? "authentication_required" : "not_installed",
        version: null,
        message: hostKeyChanged
          ? "SSH Host Key 已改变，连接已阻止"
          : hostKey
            ? "Host Key 未受信任，请先人工核对并确认指纹"
            : passphrase
              ? "请使用 ssh-agent 加载带 passphrase 的私钥"
              : authentication
            ? "Authentication required"
            : "Provider executable not found",
        checkedAt,
        latencyMs: Date.now() - started,
      };
    }
    const version = result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) || null;
    return {
      status: "ready",
      version,
      message: null,
      checkedAt,
      latencyMs: Date.now() - started,
    };
  }

  async createSession(input: {
    readonly connection: ProviderConnectionContext;
    readonly workspace: string;
  }): Promise<ExecutionSession> {
    const process = this.#createTransport(input.connection, input.workspace);
    const client = new AcpClient({ transport: process });
    const session = await AcpProcessSession.create(client, { cwd: input.workspace });
    this.#clients.set(session.session.sessionId, { client, process });
    return {
      id: session.session.sessionId,
      providerKind: this.kind,
      connectionId: input.connection.id,
      workspace: input.workspace,
      resumable: true,
    };
  }

  async resumeSession(input: {
    readonly connection: ProviderConnectionContext;
    readonly session: ExecutionSession;
    readonly workspace: string;
  }): Promise<ExecutionSession> {
    const process = this.#createTransport(input.connection, input.workspace);
    const client = new AcpClient({ transport: process });
    await AcpProcessSession.create(client, {
      cwd: input.workspace,
      sessionId: input.session.id,
    });
    this.#clients.set(input.session.id, { client, process });
    return { ...input.session, connectionId: input.connection.id, workspace: input.workspace };
  }

  async execute(input: ExecutionInput, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
    const connection =
      input.connection ?? {
        id: String(input.metadata?.connectionId ?? "unknown"),
        type: "ssh_host",
        host: typeof input.metadata?.host === "string" ? input.metadata.host : null,
        port: typeof input.metadata?.port === "number" ? input.metadata.port : null,
        username: typeof input.metadata?.username === "string" ? input.metadata.username : null,
        authMode: input.metadata?.authMode === "identity_file" ? "identity_file" : "agent",
        identityFilePath: null,
        knownHostsFile: typeof input.metadata?.knownHostsFile === "string" ? input.metadata.knownHostsFile : "/var/lib/devboard/ssh/known_hosts",
      };
    let session = input.session ?? (await this.createSession({ connection, workspace: input.workspace }));
    if (!this.#clients.has(session.id)) {
      session = await this.resumeSession({ connection, session, workspace: input.workspace });
    }
    const handle = this.#clients.get(session.id);
    if (!handle) throw new Error("ACP session is not attached to a process");
    const acpSession = { sessionId: session.id, cwd: input.workspace };
    callbacks.onSession?.(session);
    callbacks.onProviderSession?.(session.id);
    const updates: AcpUpdate[] = [];
    const removeUpdate = handle.client.onUpdate((update) => {
      updates.push(update);
      const updateValue = safeProviderEvent(update.update);
      callbacks.onEvent({
        type: eventType(update.update),
        summary: textFromUpdate(update.update).slice(0, 2_000) || "Provider 更新",
        payload: { update: updateValue },
        providerEvent: updateValue,
      });
    });
    const removePermission = handle.client.onPermission(async (request) => {
      const approval = mapApproval(request);
      const handler = /input|question|elicitation/i.test(approval.type) ? callbacks.onUserInput : callbacks.onApproval;
      const decision = await handler?.(approval);
      return approvalResult(decision ?? { type: "reject", reason: "没有可用的审批处理器" });
    });
    try {
      const result = await handle.client.prompt({
        sessionId: acpSession.sessionId,
        text: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      });
      const stopReason =
        result && typeof result === "object" && typeof (result as Record<string, unknown>).stopReason === "string"
          ? String((result as Record<string, unknown>).stopReason)
          : "end_turn";
      const status = /cancel/i.test(stopReason)
        ? "interrupted"
        : /error|fail/i.test(stopReason)
          ? "failed"
          : "succeeded";
      callbacks.onEvent({
        type: status === "succeeded" ? "run.completed" : status === "interrupted" ? "run.cancelled" : "run.failed",
        summary: status === "succeeded" ? "Provider 执行完成" : "Provider 执行未完成",
        payload: { stopReason, updateCount: updates.length },
      });
      return { status, session, providerSessionId: session.id };
    } finally {
      removeUpdate();
      removePermission();
    }
  }

  async interrupt(input: { readonly session: ExecutionSession }): Promise<void> {
    const handle = this.#clients.get(input.session.id);
    if (!handle) return;
    await handle.client.cancel(input.session.id);
  }

  async readHistory(input: {
    readonly connection: ProviderConnectionContext;
    readonly session: ExecutionSession;
  }): Promise<ExecutionHistory | null> {
    return this.#clients.has(input.session.id)
      ? { session: input.session, events: [] }
      : null;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#clients.values()].map(({ client }) => client.close()));
    this.#clients.clear();
  }

  #createTransport(connection: ProviderConnectionContext, workspace: string): ProcessTransport {
    if (!connection.host || !connection.username) throw new Error("SSH Host 与用户名尚未配置");
    return new SSHProcessTransport({
      host: connection.host,
      username: connection.username,
      port: connection.port,
      identity: connection.identityFilePath,
      authMode: connection.authMode,
      knownHostsFile: connection.knownHostsFile,
      executable: this.#executable,
      args: this.#args,
      cwd: workspace,
    });
  }
}

export const CURSOR_CAPABILITIES: ProviderCapability = {
  streaming: true,
  approvals: true,
  userInput: true,
  cancel: true,
  resume: true,
  models: false,
  reasoningEffort: false,
  modes: true,
  permissionModes: false,
  workspace: true,
};
export const GROK_CAPABILITIES: ProviderCapability = {
  ...CURSOR_CAPABILITIES,
  models: false,
  reasoningEffort: false,
};
export const OPENCODE_CAPABILITIES: ProviderCapability = {
  ...CURSOR_CAPABILITIES,
  models: true,
};
