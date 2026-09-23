import type {
  ConnectionType,
  ModelDescriptor,
  ProviderCapability,
  ProviderHealth,
  ProviderKind,
  RunEventType,
} from "@codexboard/contracts";

export interface ProviderConnectionContext {
  readonly id: string;
  readonly type: ConnectionType;
  readonly host: string | null;
  readonly port: number | null;
  readonly username: string | null;
  readonly authMode: "identity_file" | "agent";
  /** IdentityRegistry-resolved file path, internal to SSH process construction only. */
  readonly identityFilePath: string | null;
  readonly knownHostsFile: string;
}

export interface ExecutionCapabilitiesContext {
  readonly connection: ProviderConnectionContext;
  readonly workspace?: string;
}

export interface ExecutionInput {
  readonly session?: ExecutionSession;
  readonly connection?: ProviderConnectionContext;
  readonly workspace: string;
  readonly prompt: string;
  readonly model?: string | null;
  readonly mode?: string | null;
  readonly reasoningEffort?: string | null;
  readonly permissionMode?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecutionSession {
  readonly id: string;
  readonly providerKind: ProviderKind;
  readonly connectionId: string;
  readonly workspace: string;
  readonly resumable: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecutionProviderEvent {
  readonly type: RunEventType;
  readonly summary: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Provider events are retained only after adapter sanitization. */
  readonly providerEvent?: Readonly<Record<string, unknown>>;
}

export interface ExecutionApprovalRequest {
  readonly requestId: string;
  readonly type: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly choices: readonly Readonly<Record<string, unknown>>[];
}

export type ExecutionApprovalDecision =
  | { readonly type: "approve" }
  | { readonly type: "reject"; readonly reason?: string }
  | { readonly type: "cancel" }
  | {
      readonly type: "input";
      readonly answers: Readonly<Record<string, readonly string[]>>;
    };

export interface ExecutionCallbacks {
  readonly onEvent: (event: ExecutionProviderEvent) => void;
  readonly onApproval?: (
    request: ExecutionApprovalRequest,
  ) => Promise<ExecutionApprovalDecision>;
  readonly onUserInput?: (
    request: ExecutionApprovalRequest,
  ) => Promise<ExecutionApprovalDecision>;
  readonly onSession?: (session: ExecutionSession) => void;
  readonly onProviderSession?: (providerSessionId: string) => void;
}

export interface ExecutionResult {
  readonly status: "succeeded" | "interrupted" | "failed";
  readonly session: ExecutionSession;
  readonly providerSessionId?: string;
  readonly errorCode?: string;
  readonly errorSummary?: string;
}

export interface ExecutionHistory {
  readonly session: ExecutionSession;
  readonly events: readonly ExecutionProviderEvent[];
}

export interface ExecutionProvider {
  readonly kind: ProviderKind;
  readonly displayName: string;
  capabilities(context: ExecutionCapabilitiesContext): Promise<ProviderCapability>;
  health(context: ExecutionCapabilitiesContext): Promise<ProviderHealth>;
  listModels?(context: ExecutionCapabilitiesContext): Promise<readonly ModelDescriptor[]>;
  createSession(input: {
    readonly connection: ProviderConnectionContext;
    readonly workspace: string;
    readonly model?: string | null;
    readonly mode?: string | null;
  }): Promise<ExecutionSession>;
  resumeSession(input: {
    readonly connection: ProviderConnectionContext;
    readonly session: ExecutionSession;
    readonly workspace: string;
  }): Promise<ExecutionSession>;
  execute(input: ExecutionInput, callbacks: ExecutionCallbacks): Promise<ExecutionResult>;
  interrupt(input: {
    readonly session: ExecutionSession;
    readonly providerSessionId?: string;
  }): Promise<void>;
  readHistory?(input: {
    readonly connection: ProviderConnectionContext;
    readonly session: ExecutionSession;
  }): Promise<ExecutionHistory | null>;
  dispose?(): Promise<void>;
}

export interface ExecutionConnection {
  readonly id: string;
  readonly name: string;
  readonly type: ConnectionType;
  readonly host: string | null;
  readonly port: number | null;
  readonly username: string | null;
  readonly authMode: "identity_file" | "agent";
  readonly identityRef: string | null;
  readonly enabled: boolean;
}

export interface ExecutionProfile {
  readonly id: string;
  readonly name: string;
  readonly providerKind: ProviderKind;
  readonly connection: ExecutionConnection;
  readonly defaultModel: string | null;
  readonly defaultMode: string | null;
  readonly defaultReasoningEffort: string | null;
  readonly environmentRefs: readonly string[];
  readonly enabled: boolean;
}
