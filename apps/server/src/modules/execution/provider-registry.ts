import type {
  ExecutionProviderDescriptor,
  ModelDescriptor,
  ProviderCapability,
  ProviderHealth,
  ProviderKind,
} from "@codexboard/contracts";

import type {
  ExecutionCapabilitiesContext,
  ExecutionProvider,
  ExecutionResult,
  ExecutionSession,
  ExecutionInput,
  ExecutionCallbacks,
  ProviderConnectionContext,
} from "./execution-provider.js";

export class ExecutionProviderRegistry {
  readonly #providers = new Map<ProviderKind, ExecutionProvider>();

  register(provider: ExecutionProvider): void {
    if (this.#providers.has(provider.kind)) {
      throw new Error(`ExecutionProvider 已注册：${provider.kind}`);
    }
    this.#providers.set(provider.kind, provider);
  }

  get(kind: ProviderKind): ExecutionProvider | undefined {
    return this.#providers.get(kind);
  }

  require(kind: ProviderKind): ExecutionProvider {
    const provider = this.get(kind);
    if (!provider) throw new Error(`ExecutionProvider 未注册：${kind}`);
    return provider;
  }

  kinds(): readonly ProviderKind[] {
    return [...this.#providers.keys()];
  }

  async describe(
    connection?: ProviderConnectionContext,
    workspace?: string,
  ): Promise<readonly ExecutionProviderDescriptor[]> {
    if (!connection) {
      return [...this.#providers.values()].map((provider) => ({
        kind: provider.kind,
        displayName: provider.displayName,
        installed: false,
        health: {
          status: "unknown",
          version: null,
          message: "请先添加 SSH Host Connection",
          checkedAt: new Date().toISOString(),
          latencyMs: null,
        },
        capabilities: {
          streaming: false,
          approvals: false,
          userInput: false,
          cancel: false,
          resume: false,
          models: false,
          reasoningEffort: false,
          modes: false,
          permissionModes: false,
          workspace: false,
        },
        models: [],
      }));
    }
    const context: ExecutionCapabilitiesContext = {
      connection,
      ...(workspace === undefined ? {} : { workspace }),
    };
    return Promise.all(
      [...this.#providers.values()].map(async (provider) => {
        let health: ProviderHealth;
        let capabilities: ProviderCapability;
        let models: readonly ModelDescriptor[] = [];
        try {
          [health, capabilities] = await Promise.all([
            provider.health(context),
            provider.capabilities(context),
          ]);
          if (provider.listModels && health.status === "ready") models = await provider.listModels(context);
        } catch (error: unknown) {
          health = {
            status: "error",
            version: null,
            message: error instanceof Error ? error.message.slice(0, 2_000) : "Provider health check failed",
            checkedAt: new Date().toISOString(),
            latencyMs: null,
          };
          capabilities = {
            streaming: false,
            approvals: false,
            userInput: false,
            cancel: false,
            resume: false,
            models: false,
            reasoningEffort: false,
            modes: false,
            permissionModes: false,
            workspace: false,
          };
        }
        return {
          kind: provider.kind,
          displayName: provider.displayName,
          installed: health.status === "ready" || health.status === "authentication_required",
          health,
          capabilities,
          models,
        };
      }),
    );
  }

  async execute(
    kind: ProviderKind,
    input: ExecutionInput,
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    return this.require(kind).execute(input, callbacks);
  }

  async interrupt(
    kind: ProviderKind,
    input: { readonly session: ExecutionSession; readonly providerSessionId?: string },
  ): Promise<void> {
    await this.require(kind).interrupt(input);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#providers.values()].map((provider) => provider.dispose?.()));
  }
}
