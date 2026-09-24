import type { CodexTransport, JsonRpcMessage } from "../codex/protocol.js";
import { JsonRpcMessageSchema } from "../codex/protocol.js";

export interface AcpClientOptions {
  readonly transport: CodexTransport;
  readonly requestTimeoutMs?: number;
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export class AcpProtocolError extends Error {
  constructor(
    message: string,
    readonly value?: unknown,
  ) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

export class AcpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRequestError";
  }
}

export interface AcpSession {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface AcpUpdate {
  readonly sessionId?: string;
  readonly update: unknown;
}

export interface AcpServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
  respond(result: unknown): Promise<void>;
  fail(code: number, message: string, data?: unknown): Promise<void>;
}

export interface AcpPermissionRequest {
  readonly request: AcpServerRequest;
  readonly sessionId?: string;
}

export class AcpClient {
  readonly #transport: CodexTransport;
  readonly #requestTimeoutMs: number;
  readonly #clientInfo: { readonly name: string; readonly version: string };
  readonly #pending = new Map<string | number, PendingRequest>();
  readonly #updates = new Set<(update: AcpUpdate) => void>();
  readonly #permissions = new Set<(request: AcpPermissionRequest) => Promise<unknown>>();
  readonly #disconnects = new Set<(error: Error) => void>();
  #agentCapabilities: Record<string, unknown> = {};
  #nextId = 1;
  #connected = false;
  #closed = false;
  #removeMessageListener: (() => void) | undefined;
  #removeCloseListener: (() => void) | undefined;

  constructor(options: AcpClientOptions) {
    this.#transport = options.transport;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#clientInfo = options.clientInfo ?? { name: "devboard", version: "0.1.0" };
  }

  get connected(): boolean {
    return this.#connected;
  }

  get supportsLoadSession(): boolean {
    return this.#agentCapabilities.loadSession === true;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    if (this.#closed) throw new AcpProtocolError("ACP client is closed");
    this.#removeMessageListener = this.#transport.onMessage((message) => {
      void this.#handleMessage(message);
    });
    this.#removeCloseListener = this.#transport.onClose((error) => {
      this.#handleDisconnect(error ?? new AcpProtocolError("ACP transport disconnected"));
    });
    try {
      await this.#transport.connect();
      const initialized = await this.#requestRaw("initialize", {
        protocolVersion: 1,
        clientInfo: this.#clientInfo,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      const initializedValue =
        initialized && typeof initialized === "object" && !Array.isArray(initialized)
          ? (initialized as Record<string, unknown>)
          : {};
      const agentCapabilities = initializedValue.agentCapabilities;
      this.#agentCapabilities =
        agentCapabilities &&
        typeof agentCapabilities === "object" &&
        !Array.isArray(agentCapabilities)
          ? (agentCapabilities as Record<string, unknown>)
          : {};
      this.#connected = true;
    } catch (error: unknown) {
      this.#removeMessageListener?.();
      this.#removeCloseListener?.();
      this.#removeMessageListener = undefined;
      this.#removeCloseListener = undefined;
      throw error;
    }
  }

  async newSession(input: { readonly cwd: string }): Promise<AcpSession> {
    const result = await this.request("session/new", { cwd: input.cwd, mcpServers: [] });
    return this.#parseSession(result, input.cwd);
  }

  async loadSession(input: {
    readonly sessionId: string;
    readonly cwd: string;
  }): Promise<AcpSession> {
    if (!this.supportsLoadSession) {
      throw new AcpProtocolError("ACP agent does not advertise agentCapabilities.loadSession");
    }
    const result = await this.request("session/load", {
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: [],
    });
    return this.#parseSession(result, input.cwd, input.sessionId);
  }

  async prompt(input: {
    readonly sessionId: string;
    readonly text: string;
    readonly model?: string | null;
    readonly mode?: string | null;
  }): Promise<unknown> {
    return this.request("session/prompt", {
      sessionId: input.sessionId,
      prompt: [{ type: "text", text: input.text }],
      ...(input.model ? { model: input.model } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.notify("session/cancel", { sessionId });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.#connected)
      return Promise.reject(new AcpProtocolError("ACP client is not connected"));
    return this.#requestRaw(method, params);
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.#connected) throw new AcpProtocolError("ACP client is not connected");
    await this.#transport.send({ jsonrpc: "2.0", method, params });
  }

  onUpdate(listener: (update: AcpUpdate) => void): () => void {
    this.#updates.add(listener);
    return () => this.#updates.delete(listener);
  }

  onPermission(listener: (request: AcpPermissionRequest) => Promise<unknown>): () => void {
    this.#permissions.add(listener);
    return () => this.#permissions.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnects.add(listener);
    return () => this.#disconnects.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#rejectPending(new AcpProtocolError("ACP client closed"));
    this.#removeMessageListener?.();
    this.#removeCloseListener?.();
    await this.#transport.close();
  }

  async #handleMessage(raw: unknown): Promise<void> {
    const parsed = JsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#handleDisconnect(new AcpProtocolError("ACP returned an invalid JSON-RPC message", raw));
      return;
    }
    const message = parsed.data as JsonRpcMessage;
    if ("id" in message && !("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if ("error" in message) {
        pending.reject(
          new AcpRequestError(message.error.code, message.error.message, message.error.data),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("id" in message && "method" in message) {
      await this.#handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if ("method" in message) {
      const params =
        message.params && typeof message.params === "object"
          ? (message.params as Record<string, unknown>)
          : {};
      const sessionId =
        typeof params.sessionId === "string"
          ? params.sessionId
          : typeof params.conversationId === "string"
            ? params.conversationId
            : undefined;
      for (const listener of this.#updates)
        listener({ update: params, ...(sessionId ? { sessionId } : {}) });
    }
  }

  async #handleServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const request: AcpServerRequest = {
      id,
      method,
      params,
      respond: async (result) => this.#transport.send({ jsonrpc: "2.0", id, result }),
      fail: async (code, message, data) =>
        this.#transport.send({
          jsonrpc: "2.0",
          id,
          error: { code, message, ...(data === undefined ? {} : { data }) },
        }),
    };
    const sessionId =
      params &&
      typeof params === "object" &&
      typeof (params as Record<string, unknown>).sessionId === "string"
        ? ((params as Record<string, unknown>).sessionId as string)
        : undefined;
    const handler = [...this.#permissions].at(-1);
    if (!handler) {
      await request.fail(-32601, `Unsupported ACP server request: ${method}`);
      return;
    }
    try {
      await request.respond(await handler({ request, ...(sessionId ? { sessionId } : {}) }));
    } catch (error: unknown) {
      await request.fail(
        -32603,
        error instanceof Error ? error.message : "ACP permission handler failed",
      );
    }
  }

  #requestRaw(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AcpProtocolError(`ACP request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timeout });
      void this.#transport.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("ACP transport send failed"));
      });
    });
  }

  #parseSession(result: unknown, cwd: string, fallbackId?: string): AcpSession {
    if (!result || typeof result !== "object")
      throw new AcpProtocolError("ACP session response is invalid", result);
    const value = result as Record<string, unknown>;
    const sessionId =
      typeof value.sessionId === "string"
        ? value.sessionId
        : typeof value.id === "string"
          ? value.id
          : fallbackId;
    if (!sessionId) throw new AcpProtocolError("ACP session response has no sessionId", result);
    return { sessionId, cwd };
  }

  #handleDisconnect(error: Error): void {
    if (this.#closed) return;
    this.#connected = false;
    this.#rejectPending(error);
    for (const listener of this.#disconnects) listener(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export class AcpProcessSession {
  readonly #client: AcpClient;
  readonly #session: AcpSession;

  private constructor(client: AcpClient, session: AcpSession) {
    this.#client = client;
    this.#session = session;
  }

  static async create(
    client: AcpClient,
    input: { readonly cwd: string; readonly sessionId?: string },
  ): Promise<AcpProcessSession> {
    await client.connect();
    const session = input.sessionId
      ? await client.loadSession({ sessionId: input.sessionId, cwd: input.cwd })
      : await client.newSession({ cwd: input.cwd });
    return new AcpProcessSession(client, session);
  }

  get session(): AcpSession {
    return this.#session;
  }

  prompt(input: {
    readonly text: string;
    readonly model?: string | null;
    readonly mode?: string | null;
  }) {
    return this.#client.prompt({ sessionId: this.#session.sessionId, ...input });
  }

  cancel(): Promise<void> {
    return this.#client.cancel(this.#session.sessionId);
  }
}
