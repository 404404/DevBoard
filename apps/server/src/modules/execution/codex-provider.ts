import { randomUUID } from "node:crypto";

import type { InteractionDecision, TaskModelOptions } from "@codexboard/contracts";
import type { CodexServerRequest } from "../codex/protocol.js";
import { CodexJsonRpcClient } from "../codex/index.js";
import { AppServerCodexExecutor } from "./codex-executor.js";
import { SSHProcessTransport, buildSshArguments, runProcessCommand } from "./process-transports.js";
import { isSshAgentAvailable } from "./identity-registry.js";
import type { CodexExecutionCallbacks, CodexExecutionEvent } from "./codex-executor.js";
import type {
  ExecutionApprovalDecision,
  ExecutionApprovalRequest,
  ExecutionCapabilitiesContext,
  ExecutionCallbacks,
  ExecutionHistory,
  ExecutionInput,
  ExecutionProvider,
  ExecutionProviderEvent,
  ExecutionResult,
  ExecutionSession,
  ProviderConnectionContext,
} from "./execution-provider.js";
import type { ModelDescriptor, ProviderCapability, ProviderHealth } from "@codexboard/contracts";

interface RemoteCodexRuntime {
  readonly client: CodexJsonRpcClient;
  readonly executor: AppServerCodexExecutor;
  readonly threadIds: Set<string>;
}

const CODEX_CAPABILITIES: ProviderCapability = {
  streaming: true,
  approvals: true,
  userInput: true,
  cancel: true,
  resume: true,
  models: true,
  reasoningEffort: true,
  modes: false,
  permissionModes: true,
  workspace: true,
};

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value === "string" && value.length > 10_000 ? value.slice(0, 10_000) : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => safeValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (/token|secret|password|credential|authorization|private.?key|api.?key|environment/i.test(key))
        continue;
      result[key] = safeValue(entry, depth + 1);
    }
    return result;
  }
  return null;
}

function safeRecord(value: unknown): Record<string, unknown> {
  const safe = safeValue(value);
  return safe && typeof safe === "object" && !Array.isArray(safe) ? (safe as Record<string, unknown>) : {};
}

function toInteractionDecision(decision: ExecutionApprovalDecision): InteractionDecision {
  if (decision.type === "approve") return { type: "accept" };
  if (decision.type === "cancel") return { type: "cancel" };
  if (decision.type === "input") return { type: "input", answers: decision.answers };
  return { type: "decline" };
}

function fromCodexRequest(request: CodexServerRequest): ExecutionApprovalRequest {
  const params = safeRecord(request.params);
  const type =
    request.method === "execCommandApproval"
      ? "command"
      : request.method === "applyPatchApproval"
        ? "file_change"
        : request.method === "item/tool/requestUserInput"
          ? "user_input"
          : "provider_request";
  return {
    requestId: String(request.id),
    type,
    summary: `${type} 请求需要确认`,
    details: params,
    choices: [],
  };
}

function mapEvent(event: CodexExecutionEvent): ExecutionProviderEvent {
  const type =
    event.kind === "codex.agent_message"
      ? "agent.message"
      : event.kind === "codex.command"
        ? "command.completed"
        : event.kind === "codex.file_change"
          ? "file.changed"
          : event.kind === "codex.error"
            ? "run.progress"
            : "run.progress";
  return {
    type,
    summary: event.summary,
    payload: event.safePayload ? safeRecord(event.safePayload) : {},
    providerEvent: { kind: event.kind, cursor: event.cursor },
  };
}

function taskModelOptions(input: ExecutionInput): TaskModelOptions | undefined {
  if (!input.model) return undefined;
  return { model: input.model, effort: input.reasoningEffort ?? "medium", serviceTier: null };
}

export class CodexProvider implements ExecutionProvider {
  readonly kind = "codex" as const;
  readonly displayName = "Codex";
  readonly #remoteByRun = new Map<string, RemoteCodexRuntime>();
  readonly #remoteByThread = new Map<string, RemoteCodexRuntime>();

  async capabilities(_context: ExecutionCapabilitiesContext): Promise<ProviderCapability> {
    return CODEX_CAPABILITIES;
  }

  async health(context: ExecutionCapabilitiesContext): Promise<ProviderHealth> {
    if (!context.connection.host || !context.connection.username) return {
      status: "unknown", version: null, message: "请先配置 SSH Host 与用户名",
      checkedAt: new Date().toISOString(), latencyMs: null,
    };
    if (context.connection.authMode === "agent" && !(await isSshAgentAvailable())) return {
      status: "authentication_required", version: null,
      message: "SSH Agent 不可用：请检查可访问的 SSH_AUTH_SOCK socket，或改用 Identity File",
      checkedAt: new Date().toISOString(), latencyMs: 0,
    };
    const started = Date.now();
    const result = await runProcessCommand("ssh", buildSshArguments({
      host: context.connection.host,
      username: context.connection.username,
      port: context.connection.port,
      identity: context.connection.identityFilePath,
      authMode: context.connection.authMode,
      knownHostsFile: context.connection.knownHostsFile,
      executable: "codex",
      args: ["--version"],
      cwd: context.workspace ?? "/",
    }));
    if (result.exitCode === 0) return {
      status: "ready", version: result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) ?? null,
      message: null, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started,
    };
    const output = `${result.stdout} ${result.stderr}`;
    const keyChanged = /REMOTE HOST IDENTIFICATION HAS CHANGED|offending key/i.test(output);
    const keyUntrusted = /host key verification failed|known_hosts|no .* host key is known/i.test(output);
    const authentication = /permission denied|publickey|authentication failed/i.test(output);
    const passphrase = /passphrase|SSH_KEY_PASSPHRASE_REQUIRED/i.test(output);
    return {
      status: passphrase ? "key_passphrase_required" : keyChanged ? "host_key_changed" : keyUntrusted ? "host_key_untrusted" : authentication ? "authentication_required" : "not_installed",
      version: null,
      message: keyChanged ? "SSH Host Key 已改变，连接已阻止" : keyUntrusted ? "Host Key 未受信任" : passphrase ? "请使用 ssh-agent 加载带口令的私钥" : authentication ? "SSH 认证失败，请检查 Identity File 或 Agent" : "远端 Codex CLI 未安装或不可用",
      checkedAt: new Date().toISOString(), latencyMs: Date.now() - started,
    };
  }

  async listModels(context: ExecutionCapabilitiesContext): Promise<readonly ModelDescriptor[]> {
    if (!context.connection.host || !context.connection.username) return [];
    const remote = this.#createRemoteRuntime(context.connection, context.workspace ?? "/");
    try {
      return (await remote.executor.listModels?.()) ?? [];
    } finally {
      await remote.client.close();
    }
  }

  async createSession(input: {
    readonly connection: ProviderConnectionContext;
    readonly workspace: string;
    readonly model?: string | null;
  }): Promise<ExecutionSession> {
    const remote = this.#createRemoteRuntime(input.connection, input.workspace);
    try {
      const result = await remote.executor.createDraft({
        cwd: input.workspace,
        name: "DevBoard run",
        ...(input.model ? { modelOptions: { model: input.model, effort: "medium", serviceTier: null } } : {}),
      });
      return {
        id: result.threadId,
        providerKind: this.kind,
        connectionId: input.connection.id,
        workspace: result.cwd,
        resumable: true,
      };
    } finally {
      await remote.client.close();
    }
  }

  async resumeSession(input: {
    readonly connection: ProviderConnectionContext;
    readonly session: ExecutionSession;
    readonly workspace: string;
  }): Promise<ExecutionSession> {
    return {
      ...input.session,
      connectionId: input.connection.id,
      workspace: input.workspace,
      resumable: true,
    };
  }

  async execute(input: ExecutionInput, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
    const runId = typeof input.metadata?.runId === "string" ? input.metadata.runId : undefined;
    if (!input.connection) throw new Error("SSH Connection is required");
    const remote = this.#createRemoteRuntime(input.connection, input.workspace);
    if (runId) this.#remoteByRun.set(runId, remote);
    if (input.session) {
      remote.threadIds.add(input.session.id);
      this.#remoteByThread.set(input.session.id, remote);
    }
    let threadId = input.session?.id ?? "";
    let turnId: string | undefined;
    const session = (): ExecutionSession => ({
      id: threadId,
      providerKind: this.kind,
      connectionId: input.connection.id,
      workspace: input.workspace,
      resumable: true,
      ...(runId ? { metadata: { runId } } : {}),
    });
    const codexCallbacks: CodexExecutionCallbacks = {
      onThread: (value) => {
        threadId = value;
        if (remote) {
          remote.threadIds.add(value);
          this.#remoteByThread.set(value, remote);
        }
        callbacks.onSession?.(session());
      },
      onTurn: (value) => {
        turnId = value;
        callbacks.onProviderSession?.(value);
      },
      onEvent: (event) => callbacks.onEvent(mapEvent(event)),
      onInteraction: async (request) => {
        const requestView = fromCodexRequest(request);
        const handler = requestView.type === "user_input" ? callbacks.onUserInput : callbacks.onApproval;
        const decision = await handler?.(requestView);
        if (!decision) return { type: "decline" };
        return toInteractionDecision(decision);
      },
      onInteractionResolved: (requestId) => {
        callbacks.onEvent({
          type: "approval.resolved",
          summary: "审批已由 Provider 确认",
          payload: { requestId },
        });
      },
    };
    const options = taskModelOptions(input);
    const executor = remote.executor;
    try {
      const result = input.session
        ? await executor.continue(
            {
              jobId: String(input.metadata?.runId ?? randomUUID()),
              threadId: input.session.id,
              cwd: input.workspace,
              prompt: input.prompt,
              ...(options ? { modelOptions: options } : {}),
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
              ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
            },
            codexCallbacks,
          )
        : await executor.start(
            {
              jobId: String(input.metadata?.runId ?? randomUUID()),
              cwd: input.workspace,
              prompt: input.prompt,
              ...(options ? { modelOptions: options } : {}),
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
              ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
            },
            codexCallbacks,
          );
      threadId = result.threadId;
      turnId = result.turnId;
      const finalSession = session();
      return {
        status: result.status === "completed" ? "succeeded" : result.status,
        session: finalSession,
        providerSessionId: turnId,
        ...(result.errorSummary ? { errorSummary: result.errorSummary } : {}),
      };
    } finally {
      if (remote) {
        if (runId) this.#remoteByRun.delete(runId);
        for (const id of remote.threadIds) this.#remoteByThread.delete(id);
        await remote.client.close();
      }
    }
  }

  async interrupt(input: {
    readonly session: ExecutionSession;
    readonly providerSessionId?: string;
  }): Promise<void> {
    if (!input.providerSessionId) throw new Error("Codex run has no active turn");
    const runId =
      input.session.metadata && typeof input.session.metadata.runId === "string"
        ? input.session.metadata.runId
        : undefined;
    const remote = runId
      ? this.#remoteByRun.get(runId)
      : this.#remoteByThread.get(input.session.id);
    if (!remote) throw new Error("SSH app-server session is no longer attached");
    await remote.executor.interrupt(input.session.id, input.providerSessionId);
  }

  #createRemoteRuntime(connection: ProviderConnectionContext, workspace: string): RemoteCodexRuntime {
    if (!connection.host || !connection.username) throw new Error("SSH Host 与用户名尚未配置");
    const transport = new SSHProcessTransport({
      host: connection.host,
      username: connection.username,
      port: connection.port,
      identity: connection.identityFilePath,
      authMode: connection.authMode,
      knownHostsFile: connection.knownHostsFile,
      executable: "codex",
      args: ["app-server", "--listen", "stdio://"],
      cwd: workspace,
    });
    const client = new CodexJsonRpcClient({
      transport,
      clientInfo: { name: "devboard", title: "DevBoard", version: "0.1.0" },
    });
    return { client, executor: new AppServerCodexExecutor(client), threadIds: new Set<string>() };
  }

  async dispose(): Promise<void> {
    const runtimes = new Set([...this.#remoteByRun.values(), ...this.#remoteByThread.values()]);
    this.#remoteByRun.clear();
    this.#remoteByThread.clear();
    await Promise.allSettled([...runtimes].map((runtime) => runtime.client.close()));
  }

  async readHistory(input: {
    readonly connection: ProviderConnectionContext;
    readonly session: ExecutionSession;
  }): Promise<ExecutionHistory | null> {
    const remote = this.#createRemoteRuntime(input.connection, input.session.workspace);
    try {
      const history = await remote.executor.readHistory?.(input.session.id);
      if (!history) return null;
      return {
        session: input.session,
        events: history.turns.flatMap((turn) => turn.events.map(mapEvent)),
      };
    } finally {
      await remote.client.close();
    }
  }
}
