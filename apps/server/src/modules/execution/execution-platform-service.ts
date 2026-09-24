import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

import {
  ConnectionCapabilitiesSchema,
  ConnectionViewSchema,
  CreateConnectionCommandSchema,
  CreateExecutionProfileCommandSchema,
  CreateMilestoneCommandSchema,
  CreateWorkspaceMappingCommandSchema,
  ExecutionProfileViewSchema,
  ExecutionSettingsViewSchema,
  ExecutionApprovalViewSchema,
  ExecutionProviderDescriptorSchema,
  MilestoneViewSchema,
  ProviderCapabilitySchema,
  ProviderHealthSchema,
  ProjectExecutionProfileViewSchema,
  ProviderKindSchema,
  RunEventTypeSchema,
  RunViewSchema,
  UpdateConnectionCommandSchema,
  UpdateExecutionProfileCommandSchema,
  WorkspaceMappingViewSchema,
  type ConnectionView,
  type CreateConnectionCommand,
  type CreateExecutionProfileCommand,
  type CreateMilestoneCommand,
  type CreateWorkspaceMappingCommand,
  type ExecutionApprovalView,
  type ExecutionProfileView,
  type ExecutionSettingsView,
  type MilestoneView,
  type ProviderHealth,
  type ProjectExecutionProfileView,
  type ProviderKind,
  type RunEventType,
  type RunView,
  type UpdateConnectionCommand,
  type UpdateExecutionProfileCommand,
  type WorkspaceMappingView,
} from "@codexboard/contracts";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import { buildSshArguments, runProcessCommand } from "./process-transports.js";
import { SSHHostKeyStore, type SSHHostKeyView } from "./ssh-host-key-store.js";
import {
  DirectoryIdentityRegistry,
  isSshAgentAvailable,
  type IdentityRegistry,
} from "./identity-registry.js";
import type {
  ExecutionApprovalDecision,
  ExecutionApprovalRequest,
  ExecutionSession,
  ProviderConnectionContext,
} from "./execution-provider.js";
import type { ExecutionProviderRegistry } from "./provider-registry.js";

const ConnectionRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.literal("ssh_host"),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  username: z.string().nullable(),
  authMode: z.enum(["identity_file", "agent"]),
  identityRef: z.string().nullable(),
  knownHostReference: z.string(),
  status: z.enum([
    "unknown",
    "checking",
    "online",
    "offline",
    "authentication_required",
    "error",
    "configuration_required",
    "host_key_untrusted",
    "host_key_changed",
  ]),
  capabilitiesJson: z.string(),
  lastHealthJson: z.string().nullable(),
  enabled: z.number().int(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const ProfileRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  providerKind: ProviderKindSchema,
  connectionId: z.uuid(),
  connectionName: z.string(),
  defaultModel: z.string().nullable(),
  defaultMode: z.string().nullable(),
  defaultReasoningEffort: z.string().nullable(),
  environmentRefsJson: z.string(),
  capabilitiesJson: z.string(),
  healthJson: z.string().nullable(),
  enabled: z.number().int(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const MappingRowSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  connectionId: z.uuid(),
  connectionName: z.string(),
  path: z.string(),
  isDefault: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const MilestoneRowSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["planned", "active", "completed", "canceled"]),
  targetDate: z.string().nullable(),
  taskCount: z.number().int(),
  completedTaskCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const RunRowSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  executionProfileId: z.uuid().nullable(),
  executionProfileName: z.string().nullable(),
  providerKind: ProviderKindSchema,
  connectionId: z.uuid().nullable(),
  connectionName: z.string().nullable(),
  workspace: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.string().nullable(),
  permissionMode: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  providerThreadId: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  status: z.enum([
    "queued",
    "starting",
    "running",
    "waiting_approval",
    "waiting_input",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
    "disconnected",
  ]),
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

const ApprovalRowSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  providerKind: ProviderKindSchema,
  type: z.string(),
  summary: z.string(),
  detailsJson: z.string(),
  choicesJson: z.string(),
  status: z.enum(["pending", "approved", "rejected", "canceled", "expired"]),
  requestedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedBy: z.string().nullable(),
});

interface ExecutionPlatformServiceOptions {
  readonly database: SqliteDatabase;
  readonly providers: ExecutionProviderRegistry;
  readonly knownHostsFile?: string;
  readonly identityDirectory?: string;
  readonly identityRegistry?: IdentityRegistry;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function recordToProviderHealth(value: string | null): ProviderHealth | null {
  const parsed = ProviderHealthSchema.safeParse(parseJson(value, null));
  return parsed.success ? parsed.data : null;
}

function connectionContext(
  connection: ConnectionView,
  knownHostsFile: string,
  resolvedIdentityPath: string | null,
): ProviderConnectionContext {
  return {
    id: connection.id,
    type: connection.type,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMode: connection.authMode,
    identityFilePath: resolvedIdentityPath,
    knownHostsFile,
  };
}

function redactErrorSummary(value: string): string {
  return value
    .replace(/(?:token|secret|password|api.?key)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 2_000);
}

function safeProviderValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, 10_000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => safeProviderValue(entry, depth + 1));
  if (!value || typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (
      /token|secret|password|credential|authorization|private.?key|api.?key|environment/i.test(key)
    )
      continue;
    result[key] = safeProviderValue(entry, depth + 1);
  }
  return result;
}

function safeProviderPayload(value: unknown): Record<string, unknown> {
  const safe = safeProviderValue(value);
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? (safe as Record<string, unknown>)
    : {};
}

export class ExecutionPlatformService {
  readonly #database: SqliteDatabase;
  readonly #providers: ExecutionProviderRegistry;
  readonly #knownHostsFile: string;
  readonly #identityRegistry: IdentityRegistry;
  readonly #hostKeys: SSHHostKeyStore;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;
  readonly #activeRuns = new Map<
    string,
    { readonly providerKind: ProviderKind; session?: ExecutionSession; providerSessionId?: string }
  >();
  readonly #approvalWaiters = new Map<
    string,
    { readonly runId: string; readonly resolve: (decision: ExecutionApprovalDecision) => void }
  >();

  constructor(options: ExecutionPlatformServiceOptions) {
    this.#database = options.database;
    this.#providers = options.providers;
    this.#knownHostsFile = options.knownHostsFile ?? "/var/lib/devboard/ssh/known_hosts";
    this.#identityRegistry =
      options.identityRegistry ??
      new DirectoryIdentityRegistry(options.identityDirectory ?? "/run/devboard/ssh/identities");
    this.#hostKeys = new SSHHostKeyStore(this.#knownHostsFile);
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
    this.#interruptUncertainRuns();
  }

  #interruptUncertainRuns(): void {
    const rows = this.#database
      .prepare(
        `SELECT runs.id, tasks.project_id AS projectId
         FROM runs LEFT JOIN tasks ON tasks.id = runs.task_id
         WHERE runs.status IN ('queued', 'starting', 'running', 'waiting_approval', 'waiting_input')`,
      )
      .all() as { id: string; projectId: string | null }[];
    if (rows.length === 0) return;

    const timestamp = this.#now().toISOString();
    const revisions = withTransaction(this.#database, () => {
      const committed: number[] = [];
      for (const row of rows) {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'interrupted', error_code = 'RUN_RECOVERY_REQUIRED',
              error_summary = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            "容器重启中断了 SSH 会话；没有自动重放 prompt，请由用户明确 Continue 或 Retry",
            timestamp,
            timestamp,
            row.id,
          );
        this.#database
          .prepare(
            "UPDATE run_approvals SET status = 'canceled', resolved_at = ?, resolved_by = 'system' WHERE run_id = ? AND status = 'pending'",
          )
          .run(timestamp, row.id);
        this.#appendRunEvent(
          row.id,
          "run.interrupted",
          "容器重启中断了 SSH Run；未自动重放 prompt",
          { reason: "container_restart", recoveryRequired: true },
          null,
          timestamp,
        );
        committed.push(
          this.#recordChange(
            "run",
            row.id,
            "run.interrupted",
            { projectId: row.projectId, runId: row.id, reason: "container_restart" },
            timestamp,
          ),
        );
      }
      return committed;
    });
    for (const revision of revisions) this.#notify(revision);
  }

  listConnections(): readonly ConnectionView[] {
    return this.#database
      .prepare(
        `SELECT id, name, type, host, port, username, auth_mode AS authMode, identity_ref AS identityRef,
          known_host_reference AS knownHostReference, status,
          capabilities_json AS capabilitiesJson, last_health_json AS lastHealthJson,
          enabled, version, created_at AS createdAt, updated_at AS updatedAt
        FROM connections ORDER BY name COLLATE NOCASE`,
      )
      .all()
      .map((row) => this.#connectionView(ConnectionRowSchema.parse(row)));
  }

  createConnection(command: CreateConnectionCommand): {
    readonly connection: ConnectionView;
    readonly revision: number;
  } {
    const input = CreateConnectionCommandSchema.parse(command);
    this.#validateConnectionInput(input);
    const id = randomUUID();
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO connections (
            id, name, type, host, port, username, auth_mode, identity_ref, known_host_reference,
            status, capabilities_json, enabled, version, created_at, updated_at
          ) VALUES (?, ?, 'ssh_host', ?, ?, ?, ?, ?, 'managed:known_hosts', 'unknown', ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.host,
          input.port,
          input.username,
          input.authMode,
          input.identityRef,
          JSON.stringify(input.capabilities),
          input.enabled ? 1 : 0,
          timestamp,
          timestamp,
        );
      return this.#recordChange(
        "connection",
        id,
        "connection.created",
        { connectionId: id },
        timestamp,
      );
    });
    this.#notify(revision);
    return { connection: this.#readConnection(id), revision };
  }

  updateConnection(
    id: string,
    command: UpdateConnectionCommand,
  ): { readonly connection: ConnectionView; readonly revision: number } {
    const input = UpdateConnectionCommandSchema.parse(command);
    const current = this.#readConnection(id);
    const next = {
      ...current,
      name: input.name ?? current.name,
      host: input.host === undefined ? current.host : input.host,
      port: input.port === undefined ? current.port : input.port,
      username: input.username === undefined ? current.username : input.username,
      authMode: input.authMode ?? current.authMode,
      identityRef: input.identityRef === undefined ? current.identityRef : input.identityRef,
      capabilities: input.capabilities ?? current.capabilities,
      enabled: input.enabled ?? current.enabled,
    };
    this.#validateConnectionInput(next);
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          `UPDATE connections SET
            name = ?, host = ?, port = ?, username = ?, auth_mode = ?, identity_ref = ?,
            status = 'unknown', last_health_json = NULL, capabilities_json = ?,
            enabled = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
        )
        .run(
          next.name,
          next.host,
          next.port,
          next.username,
          next.authMode,
          next.identityRef,
          JSON.stringify(next.capabilities),
          next.enabled ? 1 : 0,
          timestamp,
          id,
          input.expectedVersion,
        );
      if (result.changes !== 1)
        throw new AppError("VERSION_CONFLICT", 409, "连接版本已变化，请重新加载");
      return this.#recordChange(
        "connection",
        id,
        "connection.updated",
        { connectionId: id },
        timestamp,
      );
    });
    this.#notify(revision);
    return { connection: this.#readConnection(id), revision };
  }

  deleteConnection(id: string): { readonly revision: number } {
    this.#readConnection(id);
    const used = this.#database
      .prepare("SELECT 1 FROM execution_profiles WHERE connection_id = ? LIMIT 1")
      .get(id);
    if (used) throw new AppError("INVALID_REQUEST", 409, "连接仍被 Execution Profile 使用");
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      const result = this.#database.prepare("DELETE FROM connections WHERE id = ?").run(id);
      if (result.changes !== 1) throw new AppError("NOT_FOUND", 404, "连接不存在");
      return this.#recordChange(
        "connection",
        id,
        "connection.deleted",
        { connectionId: id },
        timestamp,
      );
    });
    this.#notify(revision);
    return { revision };
  }

  async testConnection(
    id: string,
    workspace = "/",
  ): Promise<{ readonly connection: ConnectionView; readonly health: ProviderHealth }> {
    const connection = this.#readConnection(id);
    if (!isAbsolute(workspace))
      throw new AppError("WORKSPACE_NOT_FOUND", 400, "Connection 检查的 Workspace 必须是绝对路径");
    const health = await this.#testSsh(connection, workspace);
    const timestamp = this.#now().toISOString();
    const connectionStatus =
      health.status === "ready"
        ? "online"
        : health.status === "authentication_required"
          ? "authentication_required"
          : health.status === "offline"
            ? "offline"
            : health.status === "host_key_untrusted"
              ? "host_key_untrusted"
              : health.status === "host_key_changed"
                ? "host_key_changed"
                : health.status === "unknown"
                  ? "unknown"
                  : "error";
    this.#database
      .prepare(
        "UPDATE connections SET status = ?, last_health_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(connectionStatus, JSON.stringify(health), timestamp, id);
    return { connection: this.#readConnection(id), health };
  }

  async scanHostKeys(id: string): Promise<readonly SSHHostKeyView[]> {
    return this.#hostKeys.scan(this.#readConnection(id));
  }

  trustHostKey(id: string, fingerprint: string): SSHHostKeyView {
    return this.#hostKeys.trust(this.#readConnection(id), fingerprint);
  }

  listTrustedHostKeys(id: string): readonly SSHHostKeyView[] {
    return this.#hostKeys.list(this.#readConnection(id));
  }

  listProfiles(): readonly ExecutionProfileView[] {
    return this.#database
      .prepare(
        `SELECT profiles.id, profiles.name, profiles.provider_kind AS providerKind,
          profiles.connection_id AS connectionId, connections.name AS connectionName,
          profiles.default_model AS defaultModel, profiles.default_mode AS defaultMode,
          profiles.default_reasoning_effort AS defaultReasoningEffort,
          profiles.environment_refs_json AS environmentRefsJson,
          profiles.capabilities_json AS capabilitiesJson,
          profiles.health_json AS healthJson, profiles.enabled, profiles.version,
          profiles.created_at AS createdAt, profiles.updated_at AS updatedAt
        FROM execution_profiles AS profiles
        JOIN connections ON connections.id = profiles.connection_id
        ORDER BY profiles.name COLLATE NOCASE`,
      )
      .all()
      .map((row) => this.#profileView(ProfileRowSchema.parse(row)));
  }

  async createProfile(
    command: CreateExecutionProfileCommand,
  ): Promise<{ readonly profile: ExecutionProfileView; readonly revision: number }> {
    const input = CreateExecutionProfileCommandSchema.parse(command);
    const provider = this.#providers.get(input.providerKind);
    if (!provider) throw new AppError("PROVIDER_NOT_INSTALLED", 409, "Provider adapter 未安装");
    const connection = this.#readConnection(input.connectionId);
    const capabilities = await provider.capabilities({
      connection: this.#connectionContext(connection),
    });
    const id = randomUUID();
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO execution_profiles (
            id, name, provider_kind, connection_id, default_model, default_mode,
            default_reasoning_effort, environment_refs_json,
            capabilities_json, enabled, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.providerKind,
          input.connectionId,
          input.defaultModel,
          input.defaultMode,
          input.defaultReasoningEffort,
          JSON.stringify(input.environmentRefs),
          JSON.stringify(capabilities),
          input.enabled ? 1 : 0,
          timestamp,
          timestamp,
        );
      return this.#recordChange(
        "execution_profile",
        id,
        "execution_profile.created",
        { profileId: id },
        timestamp,
      );
    });
    this.#notify(revision);
    return { profile: this.#readProfile(id), revision };
  }

  async updateProfile(
    id: string,
    command: UpdateExecutionProfileCommand,
  ): Promise<{ readonly profile: ExecutionProfileView; readonly revision: number }> {
    const input = UpdateExecutionProfileCommandSchema.parse(command);
    const current = this.#readProfile(id);
    const nextConnectionId = input.connectionId ?? current.connectionId;
    const nextProviderKind = input.providerKind ?? current.providerKind;
    const connection = this.#readConnection(nextConnectionId);
    const provider = this.#providers.get(nextProviderKind);
    if (!provider) throw new AppError("PROVIDER_NOT_INSTALLED", 409, "Provider adapter 未安装");
    const capabilities = await provider.capabilities({
      connection: this.#connectionContext(connection),
    });
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          `UPDATE execution_profiles SET
            name = ?, provider_kind = ?, connection_id = ?, default_model = ?, default_mode = ?,
            default_reasoning_effort = ?, environment_refs_json = ?,
            capabilities_json = ?, health_json = NULL, enabled = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
        )
        .run(
          input.name ?? current.name,
          nextProviderKind,
          nextConnectionId,
          input.defaultModel === undefined ? current.defaultModel : input.defaultModel,
          input.defaultMode === undefined ? current.defaultMode : input.defaultMode,
          input.defaultReasoningEffort === undefined
            ? current.defaultReasoningEffort
            : input.defaultReasoningEffort,
          JSON.stringify(input.environmentRefs ?? current.environmentRefs),
          JSON.stringify(capabilities),
          (input.enabled ?? current.enabled) ? 1 : 0,
          timestamp,
          id,
          input.expectedVersion,
        );
      if (result.changes !== 1)
        throw new AppError("VERSION_CONFLICT", 409, "Execution Profile 版本已变化，请重新加载");
      return this.#recordChange(
        "execution_profile",
        id,
        "execution_profile.updated",
        { profileId: id },
        timestamp,
      );
    });
    this.#notify(revision);
    return { profile: this.#readProfile(id), revision };
  }

  deleteProfile(id: string): { readonly revision: number } {
    this.#readProfile(id);
    const active = this.#database
      .prepare(
        "SELECT 1 FROM runs WHERE execution_profile_id = ? AND status IN ('queued', 'starting', 'running', 'waiting_approval', 'waiting_input') LIMIT 1",
      )
      .get(id);
    if (active) throw new AppError("INVALID_REQUEST", 409, "执行配置仍有活动 Run");
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      const result = this.#database.prepare("DELETE FROM execution_profiles WHERE id = ?").run(id);
      if (result.changes !== 1) throw new AppError("NOT_FOUND", 404, "Execution Profile 不存在");
      return this.#recordChange(
        "execution_profile",
        id,
        "execution_profile.deleted",
        { profileId: id },
        timestamp,
      );
    });
    this.#notify(revision);
    return { revision };
  }

  readProjectDefaultProfile(projectId: string): ProjectExecutionProfileView {
    this.#assertProject(projectId);
    const row = this.#database
      .prepare("SELECT default_execution_profile_id AS profileId FROM projects WHERE id = ?")
      .get(projectId) as { profileId: string | null } | undefined;
    return ProjectExecutionProfileViewSchema.parse({
      projectId,
      profileId: row?.profileId ?? null,
    });
  }

  setProjectDefaultProfile(
    projectId: string,
    profileId: string | null,
  ): { readonly setting: ProjectExecutionProfileView; readonly revision: number } {
    this.#assertProject(projectId);
    if (profileId !== null) this.#readProfile(profileId);
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          "UPDATE projects SET default_execution_profile_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND archived_at IS NULL",
        )
        .run(profileId, timestamp, projectId);
      if (result.changes !== 1) throw new AppError("NOT_FOUND", 404, "项目不存在或已归档");
      return this.#recordChange(
        "project",
        projectId,
        "project.execution_profile.updated",
        { projectId, profileId },
        timestamp,
      );
    });
    this.#notify(revision);
    return { setting: this.readProjectDefaultProfile(projectId), revision };
  }

  resolveExecutionProfile(projectId: string, requested?: string | null): string {
    this.#assertProject(projectId);
    if (requested !== undefined && requested !== null) {
      this.#readProfile(requested);
      return requested;
    }
    const setting = this.readProjectDefaultProfile(projectId);
    if (!setting.profileId)
      throw new AppError(
        "INVALID_REQUEST",
        409,
        "请先为该项目设置默认 Execution Profile，或在任务中选择执行配置",
      );
    this.#readProfile(setting.profileId);
    return setting.profileId;
  }

  listMappings(projectId: string): readonly WorkspaceMappingView[] {
    return this.#database
      .prepare(
        `SELECT mappings.id, mappings.project_id AS projectId, mappings.connection_id AS connectionId,
          connections.name AS connectionName, mappings.path, mappings.is_default AS isDefault,
          mappings.created_at AS createdAt, mappings.updated_at AS updatedAt
        FROM workspace_mappings AS mappings
        JOIN connections ON connections.id = mappings.connection_id
        WHERE mappings.project_id = ? ORDER BY mappings.is_default DESC, connections.name COLLATE NOCASE`,
      )
      .all(projectId)
      .map((row) =>
        WorkspaceMappingViewSchema.parse(this.#mappingView(MappingRowSchema.parse(row))),
      );
  }

  async createMapping(
    command: CreateWorkspaceMappingCommand,
  ): Promise<{ readonly mapping: WorkspaceMappingView; readonly revision: number }> {
    const input = CreateWorkspaceMappingCommandSchema.parse(command);
    if (!isAbsolute(input.path))
      throw new AppError("WORKSPACE_NOT_FOUND", 400, "Workspace path 必须是绝对路径");
    this.#assertProject(input.projectId);
    const connection = this.#readConnection(input.connectionId);
    const remote = await this.#inspectRemoteWorkspace(connection, input.path);
    if (!remote.exists)
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        404,
        "目标 Connection 上不存在该目录；可显式选择‘远端创建并映射’",
      );
    const remotePath = remote.canonicalPath;
    let mappingId: string = randomUUID();
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      const existing = this.#database
        .prepare("SELECT id FROM workspace_mappings WHERE project_id = ? AND connection_id = ?")
        .get(input.projectId, input.connectionId) as { id: string } | undefined;
      mappingId = existing?.id ?? mappingId;
      if (input.isDefault) {
        this.#database
          .prepare("UPDATE workspace_mappings SET is_default = 0 WHERE project_id = ?")
          .run(input.projectId);
      }
      if (existing) {
        this.#database
          .prepare(
            "UPDATE workspace_mappings SET path = ?, is_default = ?, updated_at = ? WHERE id = ?",
          )
          .run(remotePath, input.isDefault ? 1 : 0, timestamp, mappingId);
        return this.#recordChange(
          "workspace_mapping",
          mappingId,
          "workspace_mapping.updated",
          { projectId: input.projectId },
          timestamp,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO workspace_mappings (
            id, project_id, connection_id, path, is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mappingId,
          input.projectId,
          input.connectionId,
          remotePath,
          input.isDefault ? 1 : 0,
          timestamp,
          timestamp,
        );
      return this.#recordChange(
        "workspace_mapping",
        mappingId,
        "workspace_mapping.created",
        { projectId: input.projectId },
        timestamp,
      );
    });
    this.#notify(revision);
    return { mapping: this.#mappingViewById(mappingId), revision };
  }

  async createRemoteWorkspaceMapping(
    command: CreateWorkspaceMappingCommand,
  ): Promise<{ readonly mapping: WorkspaceMappingView; readonly revision: number }> {
    const input = CreateWorkspaceMappingCommandSchema.parse(command);
    if (!isAbsolute(input.path))
      throw new AppError("WORKSPACE_NOT_FOUND", 400, "Workspace path 必须是绝对路径");
    this.#assertProject(input.projectId);
    const connection = this.#readConnection(input.connectionId);
    const result = await this.#runRemoteShell(
      connection,
      'mkdir -p -- "$1" && cd -- "$1" && pwd -P',
      [input.path],
    );
    const canonicalPath = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!canonicalPath || !isAbsolute(canonicalPath))
      throw new AppError("WORKSPACE_NOT_FOUND", 409, "远端目录创建失败或返回了无效路径");
    return this.createMapping({ ...input, path: canonicalPath });
  }

  async inspectWorkspace(
    connectionId: string,
    path: string,
  ): Promise<{
    readonly path: string;
    readonly exists: boolean;
    readonly isGitRepository: boolean;
    readonly gitRoot: string | null;
    readonly branch: string | null;
    readonly origin: string | null;
  }> {
    if (!isAbsolute(path))
      throw new AppError("WORKSPACE_NOT_FOUND", 400, "Workspace path 必须是绝对路径");
    const connection = this.#readConnection(connectionId);
    const result = await this.#runRemoteShell(
      connection,
      'if [ ! -d "$1" ]; then printf "MISSING\\n"; exit 3; fi; cd -- "$1" || exit 4; printf "EXISTS\\n"; pwd -P; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf "GIT\\n"; git rev-parse --show-toplevel; git branch --show-current; git remote get-url origin 2>/dev/null || true; else printf "NOGIT\\n"; fi',
      [path],
      true,
    );
    const lines = result.stdout.trim().split(/\r?\n/);
    if (lines[0] === "MISSING")
      return {
        path,
        exists: false,
        isGitRepository: false,
        gitRoot: null,
        branch: null,
        origin: null,
      };
    const existsAt = lines.indexOf("EXISTS");
    if (existsAt < 0)
      throw new AppError("WORKSPACE_NOT_FOUND", 409, "无法读取目标 Host 上的 Workspace");
    const canonicalPath = lines[existsAt + 1] ?? path;
    const gitAt = lines.indexOf("GIT");
    return {
      path: canonicalPath,
      exists: true,
      isGitRepository: gitAt >= 0,
      gitRoot: gitAt >= 0 ? (lines[gitAt + 1] ?? null) : null,
      branch: gitAt >= 0 ? lines[gitAt + 2] || null : null,
      origin: gitAt >= 0 ? lines[gitAt + 3] || null : null,
    };
  }

  deleteMapping(id: string, expectedProjectId?: string): { readonly revision: number } {
    const mapping = this.#database
      .prepare(
        "SELECT project_id AS projectId FROM workspace_mappings WHERE id = ? AND (? IS NULL OR project_id = ?)",
      )
      .get(id, expectedProjectId ?? null, expectedProjectId ?? null) as
      { projectId: string } | undefined;
    if (!mapping) throw new AppError("NOT_FOUND", 404, "Workspace Mapping 不存在");
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      this.#database.prepare("DELETE FROM workspace_mappings WHERE id = ?").run(id);
      return this.#recordChange(
        "workspace_mapping",
        id,
        "workspace_mapping.deleted",
        { projectId: mapping.projectId },
        timestamp,
      );
    });
    this.#notify(revision);
    return { revision };
  }

  listMilestones(projectId: string): readonly MilestoneView[] {
    return this.#database
      .prepare(
        `SELECT milestones.id, milestones.project_id AS projectId, milestones.title,
          milestones.description, milestones.status, milestones.target_date AS targetDate,
          COUNT(tasks.id) AS taskCount,
          SUM(CASE WHEN tasks.status IN ('done', 'canceled') THEN 1 ELSE 0 END) AS completedTaskCount,
          milestones.created_at AS createdAt, milestones.updated_at AS updatedAt
        FROM milestones
        LEFT JOIN tasks ON tasks.milestone_id = milestones.id
        WHERE milestones.project_id = ?
        GROUP BY milestones.id
        ORDER BY milestones.target_date IS NULL, milestones.target_date, milestones.title COLLATE NOCASE`,
      )
      .all(projectId)
      .map((row) => {
        const raw = row as Record<string, unknown>;
        const value = MilestoneRowSchema.parse({
          ...raw,
          completedTaskCount: Number(raw.completedTaskCount ?? 0),
        });
        return MilestoneViewSchema.parse(value);
      });
  }

  createMilestone(command: CreateMilestoneCommand): {
    readonly milestone: MilestoneView;
    readonly revision: number;
  } {
    const input = CreateMilestoneCommandSchema.parse(command);
    this.#assertProject(input.projectId);
    const id = randomUUID();
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO milestones (id, project_id, title, description, status, target_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.title,
          input.description,
          input.status,
          input.targetDate,
          timestamp,
          timestamp,
        );
      return this.#recordChange(
        "milestone",
        id,
        "milestone.created",
        { projectId: input.projectId },
        timestamp,
      );
    });
    this.#notify(revision);
    return { milestone: this.#readMilestone(id), revision };
  }

  readRun(runId: string): RunView {
    const run = RunRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT runs.id, runs.task_id AS taskId, runs.execution_profile_id AS executionProfileId,
            execution_profiles.name AS executionProfileName, runs.provider_kind AS providerKind,
            runs.connection_id AS connectionId, connections.name AS connectionName,
            runs.workspace, runs.model, runs.mode, runs.permission_mode AS permissionMode, runs.reasoning_effort AS reasoningEffort,
            runs.provider_thread_id AS providerThreadId, runs.provider_session_id AS providerSessionId,
            runs.status, runs.error_code AS errorCode, runs.error_summary AS errorSummary,
            runs.created_at AS createdAt, runs.started_at AS startedAt, runs.finished_at AS finishedAt
          FROM runs
          LEFT JOIN execution_profiles ON execution_profiles.id = runs.execution_profile_id
          LEFT JOIN connections ON connections.id = runs.connection_id
          WHERE runs.id = ?`,
        )
        .get(runId),
    );
    if (!run.success) throw new AppError("NOT_FOUND", 404, "Run 不存在");
    const events = this.#database
      .prepare(
        `SELECT id, seq, event_type AS type, summary, safe_payload_json AS payload,
          provider_event_json AS providerEvent, created_at AS createdAt
         FROM run_events WHERE run_id = ? ORDER BY seq`,
      )
      .all(runId)
      .map((row) => ({
        ...(row as Record<string, unknown>),
        payload: safeProviderPayload(parseJson((row as { payload: string }).payload, {})),
        providerEvent:
          (row as { providerEvent: string | null }).providerEvent === null
            ? null
            : safeProviderPayload(
                parseJson((row as { providerEvent: string | null }).providerEvent, {}),
              ),
      }));
    return RunViewSchema.parse({ ...run.data, events });
  }

  listRuns(taskId: string): readonly RunView[] {
    const ids = this.#database
      .prepare("SELECT id FROM runs WHERE task_id = ? ORDER BY created_at DESC")
      .pluck()
      .all(taskId) as string[];
    return ids.map((id) => this.readRun(id));
  }

  resolveWorkspace(
    projectId: string,
    executionProfileId: string,
    requested?: string | null,
  ): string {
    this.#assertProject(projectId);
    const profile = this.#readProfile(executionProfileId);
    const mapping = this.#database
      .prepare(
        "SELECT path FROM workspace_mappings WHERE project_id = ? AND connection_id = ? ORDER BY is_default DESC, created_at LIMIT 1",
      )
      .get(projectId, profile.connectionId) as { path: string } | undefined;
    if (!mapping || !isAbsolute(mapping.path))
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        400,
        "请先为该项目和 SSH Connection 配置 Workspace Mapping",
      );
    if (requested !== undefined && requested !== null) {
      if (requested !== mapping.path)
        throw new AppError(
          "FORBIDDEN",
          403,
          "Run Workspace 必须来自该项目与 SSH Connection 的 Workspace Mapping",
        );
    }
    return mapping.path;
  }

  createRun(input: {
    readonly taskId: string;
    readonly executionProfileId: string;
    readonly workspace: string;
    readonly model?: string | null;
    readonly mode?: string | null;
    readonly permissionMode?: string | null;
    readonly reasoningEffort?: string | null;
    readonly providerThreadId?: string | null;
  }): RunView {
    const profile = this.#readProfile(input.executionProfileId);
    this.#assertTask(input.taskId);
    if (!isAbsolute(input.workspace))
      throw new AppError("WORKSPACE_NOT_FOUND", 400, "Run workspace 必须是绝对路径");
    if (!profile.enabled) throw new AppError("INVALID_REQUEST", 409, "Execution Profile 已禁用");
    const project = this.#database
      .prepare("SELECT project_id AS projectId FROM tasks WHERE id = ?")
      .get(input.taskId) as { projectId: string } | undefined;
    if (!project) throw new AppError("NOT_FOUND", 404, "任务不存在");
    const mapping = this.#database
      .prepare("SELECT path FROM workspace_mappings WHERE project_id = ? AND connection_id = ?")
      .get(project.projectId, profile.connectionId) as { path: string } | undefined;
    if (!mapping || mapping.path !== input.workspace)
      throw new AppError(
        "FORBIDDEN",
        403,
        "新 Run 的 Workspace 必须匹配该项目与 Connection 的 Workspace Mapping",
      );
    return this.#insertRun({
      taskId: input.taskId,
      projectId: project.projectId,
      executionProfileId: profile.id,
      providerKind: profile.providerKind,
      connectionId: profile.connectionId,
      workspace: input.workspace,
      model: input.model ?? profile.defaultModel,
      mode: input.mode ?? profile.defaultMode,
      permissionMode: input.permissionMode ?? null,
      reasoningEffort: input.reasoningEffort ?? profile.defaultReasoningEffort,
      providerThreadId: input.providerThreadId ?? null,
    });
  }

  #insertRun(input: {
    readonly taskId: string;
    readonly projectId: string;
    readonly executionProfileId: string;
    readonly providerKind: ProviderKind;
    readonly connectionId: string;
    readonly workspace: string;
    readonly model: string | null;
    readonly mode: string | null;
    readonly permissionMode: string | null;
    readonly reasoningEffort: string | null;
    readonly providerThreadId: string | null;
  }): RunView {
    const timestamp = this.#now().toISOString();
    const id = randomUUID();
    const revision = withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO runs (
            id, task_id, execution_profile_id, provider_kind, connection_id, workspace,
            model, mode, permission_mode, reasoning_effort, provider_thread_id, provider_session_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          input.executionProfileId,
          input.providerKind,
          input.connectionId,
          input.workspace,
          input.model,
          input.mode,
          input.permissionMode,
          input.reasoningEffort,
          input.providerThreadId,
          timestamp,
          timestamp,
        );
      this.#appendRunEvent(id, "run.started", "Run 已进入队列", {}, null, timestamp);
      return this.#recordChange(
        "run",
        id,
        "run.created",
        { projectId: input.projectId, taskId: input.taskId },
        timestamp,
      );
    });
    this.#notify(revision);
    return this.readRun(id);
  }

  appendRunEvent(
    runId: string,
    input: {
      readonly type: RunEventType;
      readonly summary: string;
      readonly payload?: Readonly<Record<string, unknown>>;
      readonly providerEvent?: Readonly<Record<string, unknown>>;
    },
  ): RunView {
    const timestamp = this.#now().toISOString();
    const projectId = this.#projectIdForRun(runId);
    const revision = withTransaction(this.#database, () => {
      this.#appendRunEvent(
        runId,
        input.type,
        input.summary,
        input.payload ?? {},
        input.providerEvent ?? null,
        timestamp,
      );
      const status =
        input.type === "run.completed"
          ? "succeeded"
          : input.type === "run.interrupted"
            ? "interrupted"
            : input.type === "run.failed"
              ? "failed"
              : input.type === "run.cancelled"
                ? "canceled"
                : input.type === "approval.requested"
                  ? "waiting_approval"
                  : input.type === "user.input.requested"
                    ? "waiting_input"
                    : input.type === "approval.resolved" || input.type === "user.input.resolved"
                      ? "running"
                      : input.type === "run.progress" ||
                          input.type === "agent.message" ||
                          input.type === "agent.thinking" ||
                          input.type === "tool.started" ||
                          input.type === "tool.completed" ||
                          input.type === "command.started" ||
                          input.type === "command.completed" ||
                          input.type === "file.changed" ||
                          input.type === "artifact.created"
                        ? "running"
                        : null;
      if (status) {
        const current = this.#database
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(runId) as { status: string } | undefined;
        const terminal =
          current &&
          ["succeeded", "failed", "canceled", "interrupted", "disconnected"].includes(
            current.status,
          );
        if (terminal)
          return this.#recordChange(
            "run",
            runId,
            "run.event_recorded",
            { projectId, runId },
            timestamp,
          );
        this.#database
          .prepare("UPDATE runs SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?")
          .run(
            status,
            ["succeeded", "failed", "canceled", "interrupted"].includes(status) ? timestamp : null,
            timestamp,
            runId,
          );
      }
      const eventName = "run." + input.type.slice(input.type.indexOf(".") + 1);
      return this.#recordChange("run", runId, eventName, { projectId, runId }, timestamp);
    });
    this.#notify(revision);
    return this.readRun(runId);
  }

  startRun(runId: string, prompt: string): RunView {
    const run = this.readRun(runId);
    if (run.status !== "queued") throw new AppError("INVALID_REQUEST", 409, "Run 当前状态不能启动");
    const timestamp = this.#now().toISOString();
    const projectId = this.#projectIdForRun(runId);
    const revision = withTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          "UPDATE runs SET status = 'starting', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(timestamp, timestamp, runId);
      if (result.changes !== 1) throw new AppError("INVALID_REQUEST", 409, "Run 当前状态不能启动");
      this.#appendRunEvent(runId, "run.started", "Run 正在连接执行器", {}, null, timestamp);
      return this.#recordChange("run", runId, "run.starting", { projectId, runId }, timestamp);
    });
    this.#notify(revision);
    void this.#executeRun(runId, prompt);
    return this.readRun(runId);
  }

  continueRun(runId: string, prompt: string): RunView {
    const previous = this.readRun(runId);
    if (
      ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(
        previous.status,
      )
    )
      throw new AppError("INVALID_REQUEST", 409, "活动 Run 仍在执行，不能 Continue");
    if (
      !previous.providerThreadId ||
      !previous.executionProfileId ||
      !previous.connectionId ||
      !previous.workspace
    )
      throw new AppError("INVALID_REQUEST", 409, "该 Run 没有可恢复的 Provider session");
    const text = prompt.trim();
    if (!text) throw new AppError("INVALID_REQUEST", 400, "Continue prompt 不能为空");
    const profile = this.#readProfile(previous.executionProfileId);
    if (!profile.enabled) throw new AppError("INVALID_REQUEST", 409, "Execution Profile 已禁用");
    const next = this.#insertRun({
      taskId: previous.taskId,
      projectId: this.#projectIdForRun(runId),
      executionProfileId: previous.executionProfileId,
      providerKind: previous.providerKind,
      connectionId: previous.connectionId,
      workspace: previous.workspace,
      model: previous.model,
      mode: previous.mode,
      permissionMode: previous.permissionMode,
      reasoningEffort: previous.reasoningEffort,
      providerThreadId: previous.providerThreadId,
    });
    return this.startRun(next.id, text);
  }

  async interruptRun(runId: string): Promise<RunView> {
    const run = this.readRun(runId);
    if (["succeeded", "failed", "canceled", "interrupted", "disconnected"].includes(run.status))
      return run;
    const active = this.#activeRuns.get(runId);
    const providerSessionId = active?.providerSessionId ?? run.providerSessionId;
    if (active?.session) {
      try {
        await this.#providers.interrupt(active.providerKind, {
          session: active.session,
          ...(providerSessionId ? { providerSessionId } : {}),
        });
      } catch {
        // A disconnected provider is still canceled from the board point of view.
      }
    }
    const timestamp = this.#now().toISOString();
    for (const [approvalId, waiter] of this.#approvalWaiters) {
      if (waiter.runId !== runId) continue;
      this.#approvalWaiters.delete(approvalId);
      waiter.resolve({ type: "cancel" });
    }
    this.#database
      .prepare(
        "UPDATE run_approvals SET status = 'canceled', resolved_at = ?, resolved_by = 'system' WHERE run_id = ? AND status = 'pending'",
      )
      .run(timestamp, runId);
    const current = this.readRun(runId);
    if (
      !["succeeded", "failed", "canceled", "interrupted", "disconnected"].includes(current.status)
    ) {
      this.appendRunEvent(runId, {
        type: "run.cancelled",
        summary: "Run 已取消",
      });
    }
    return this.readRun(runId);
  }

  listApprovals(runId: string): readonly ExecutionApprovalView[] {
    this.readRun(runId);
    return this.#database
      .prepare(
        "SELECT id, run_id AS runId, provider_kind AS providerKind, approval_type AS type, " +
          "summary, details_json AS detailsJson, choices_json AS choicesJson, status, " +
          "requested_at AS requestedAt, resolved_at AS resolvedAt, resolved_by AS resolvedBy " +
          "FROM run_approvals WHERE run_id = ? ORDER BY requested_at",
      )
      .all(runId)
      .map((row) => this.#approvalView(ApprovalRowSchema.parse(row)));
  }

  readApproval(approvalId: string): ExecutionApprovalView {
    const row = ApprovalRowSchema.safeParse(
      this.#database
        .prepare(
          "SELECT id, run_id AS runId, provider_kind AS providerKind, approval_type AS type, " +
            "summary, details_json AS detailsJson, choices_json AS choicesJson, status, " +
            "requested_at AS requestedAt, resolved_at AS resolvedAt, resolved_by AS resolvedBy " +
            "FROM run_approvals WHERE id = ?",
        )
        .get(approvalId),
    );
    if (!row.success) throw new AppError("NOT_FOUND", 404, "Execution Approval 不存在");
    return this.#approvalView(row.data);
  }

  resolveApproval(
    approvalId: string,
    decision: ExecutionApprovalDecision,
    resolvedBy: string,
  ): ExecutionApprovalView {
    const row = ApprovalRowSchema.safeParse(
      this.#database
        .prepare(
          "SELECT id, run_id AS runId, provider_kind AS providerKind, approval_type AS type, " +
            "summary, details_json AS detailsJson, choices_json AS choicesJson, status, " +
            "requested_at AS requestedAt, resolved_at AS resolvedAt, resolved_by AS resolvedBy " +
            "FROM run_approvals WHERE id = ?",
        )
        .get(approvalId),
    );
    if (!row.success) throw new AppError("NOT_FOUND", 404, "Execution Approval 不存在");
    if (row.data.status !== "pending")
      throw new AppError("INVALID_REQUEST", 409, "Execution Approval 已经处理");
    const status =
      decision.type === "approve" || decision.type === "input"
        ? "approved"
        : decision.type === "cancel"
          ? "canceled"
          : "rejected";
    const timestamp = this.#now().toISOString();
    const projectId = this.#projectIdForRun(row.data.runId);
    const revision = withTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          "UPDATE run_approvals SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'",
        )
        .run(status, timestamp, resolvedBy.slice(0, 200), approvalId);
      if (result.changes !== 1)
        throw new AppError("INVALID_REQUEST", 409, "Execution Approval 已经处理");
      this.#appendRunEvent(
        row.data.runId,
        row.data.type === "user_input" ? "user.input.resolved" : "approval.resolved",
        "Execution Approval 已处理",
        { approvalId, status },
        null,
        timestamp,
      );
      this.#database
        .prepare(
          "UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('waiting_approval', 'waiting_input')",
        )
        .run(timestamp, row.data.runId);
      return this.#recordChange(
        "run",
        row.data.runId,
        "run.approval_resolved",
        { projectId, runId: row.data.runId, approvalId },
        timestamp,
      );
    });
    this.#notify(revision);
    const waiter = this.#approvalWaiters.get(approvalId);
    this.#approvalWaiters.delete(approvalId);
    waiter?.resolve(decision);
    return this.#approvalView(
      ApprovalRowSchema.parse(
        this.#database
          .prepare(
            "SELECT id, run_id AS runId, provider_kind AS providerKind, approval_type AS type, " +
              "summary, details_json AS detailsJson, choices_json AS choicesJson, status, " +
              "requested_at AS requestedAt, resolved_at AS resolvedAt, resolved_by AS resolvedBy " +
              "FROM run_approvals WHERE id = ?",
          )
          .get(approvalId),
      ),
    );
  }

  #readRunContext(runId: string) {
    const run = this.readRun(runId);
    if (!run.connectionId || !run.executionProfileId)
      throw new AppError(
        "CONNECTION_OFFLINE",
        409,
        "Run 没有可用的 Connection 或 Execution Profile",
      );
    const connection = this.#readConnection(run.connectionId);
    const profile = this.#readProfile(run.executionProfileId);
    if (!connection.enabled) throw new AppError("CONNECTION_OFFLINE", 409, "Connection 已禁用");
    if (!profile.enabled) throw new AppError("INVALID_REQUEST", 409, "Execution Profile 已禁用");
    if (connection.status === "configuration_required")
      throw new AppError(
        "CONNECTION_OFFLINE",
        409,
        "旧版本机 Codex Profile 尚未配置，请关联 Docker Host SSH Connection",
      );
    if (connection.status === "authentication_required") {
      throw new AppError("SSH_AUTH_FAILED", 409, "Connection 需要完成认证");
    }
    if (
      connection.status === "offline" ||
      connection.status === "error" ||
      connection.status === "host_key_untrusted" ||
      connection.status === "host_key_changed"
    ) {
      throw new AppError("CONNECTION_OFFLINE", 409, "Connection 当前不可用，请先完成健康检查");
    }
    const provider = this.#providers.get(run.providerKind);
    if (!provider) throw new AppError("PROVIDER_NOT_INSTALLED", 409, "Provider adapter 未安装");
    const workspace = run.workspace;
    if (!workspace || !isAbsolute(workspace))
      throw new AppError("WORKSPACE_NOT_FOUND", 400, "Run workspace 必须是绝对路径");
    return { run, connection, profile, provider, workspace };
  }

  async #executeRun(runId: string, prompt: string): Promise<void> {
    let context;
    try {
      context = this.#readRunContext(runId);
    } catch (error) {
      this.#failRun(runId, error);
      return;
    }
    if (this.readRun(runId).status !== "starting") return;
    try {
      if (context.connection.authMode === "agent" && !(await isSshAgentAvailable())) {
        throw new AppError(
          "SSH_AGENT_UNAVAILABLE",
          409,
          "SSH Agent 不可用：请检查 socket 挂载与 SSH_AUTH_SOCK，或改用 Identity File",
        );
      }
      const capabilities = await context.provider.capabilities({
        connection: this.#connectionContext(context.connection),
        workspace: context.workspace,
      });
      if (context.run.model && !capabilities.models)
        throw new AppError(
          "MODEL_UNAVAILABLE",
          409,
          context.provider.displayName + " 不支持模型参数",
        );
      if (context.run.mode && !capabilities.modes)
        throw new AppError(
          "INVALID_REQUEST",
          409,
          context.provider.displayName + " 不支持 mode 参数",
        );
      if (context.run.reasoningEffort && !capabilities.reasoningEffort)
        throw new AppError(
          "INVALID_REQUEST",
          409,
          context.provider.displayName + " 不支持 reasoning effort",
        );
      if (context.run.permissionMode && !capabilities.permissionModes)
        throw new AppError(
          "INVALID_REQUEST",
          409,
          context.provider.displayName + " 不支持 permission mode",
        );
    } catch (error) {
      this.#failRun(runId, error);
      return;
    }
    if (this.readRun(runId).status !== "starting") return;
    this.#activeRuns.set(runId, { providerKind: context.run.providerKind });
    const callbacks = {
      onEvent: (event: {
        readonly type: RunEventType;
        readonly summary: string;
        readonly payload?: Readonly<Record<string, unknown>>;
        readonly providerEvent?: Readonly<Record<string, unknown>>;
      }) => {
        this.appendRunEvent(runId, event);
      },
      onSession: (session: ExecutionSession) => {
        const active = this.#activeRuns.get(runId);
        if (active) this.#activeRuns.set(runId, { ...active, session });
        this.#database
          .prepare("UPDATE runs SET provider_thread_id = ?, updated_at = ? WHERE id = ?")
          .run(session.id.slice(0, 500), this.#now().toISOString(), runId);
      },
      onProviderSession: (providerSessionId: string) => {
        const active = this.#activeRuns.get(runId);
        if (active) this.#activeRuns.set(runId, { ...active, providerSessionId });
        this.#database
          .prepare("UPDATE runs SET provider_session_id = ?, updated_at = ? WHERE id = ?")
          .run(providerSessionId.slice(0, 500), this.#now().toISOString(), runId);
      },
      onApproval: (request: ExecutionApprovalRequest) =>
        this.#waitForApproval(runId, context.run.providerKind, request, "approval"),
      onUserInput: (request: ExecutionApprovalRequest) =>
        this.#waitForApproval(runId, context.run.providerKind, request, "user_input"),
    };
    try {
      const result = await context.provider.execute(
        {
          workspace: context.workspace,
          connection: this.#connectionContext(context.connection),
          ...(context.run.providerThreadId
            ? {
                session: {
                  id: context.run.providerThreadId,
                  providerKind: context.run.providerKind,
                  connectionId: context.connection.id,
                  workspace: context.workspace,
                  resumable: true,
                  metadata: { runId },
                } satisfies ExecutionSession,
              }
            : {}),
          prompt,
          ...(context.run.model ? { model: context.run.model } : {}),
          ...(context.run.mode ? { mode: context.run.mode } : {}),
          ...(context.run.permissionMode ? { permissionMode: context.run.permissionMode } : {}),
          reasoningEffort: context.run.reasoningEffort ?? context.profile.defaultReasoningEffort,
          metadata: { runId },
        },
        callbacks,
      );
      const current = this.readRun(runId);
      if (
        !["succeeded", "failed", "canceled", "interrupted", "disconnected"].includes(current.status)
      ) {
        const eventType =
          result.status === "succeeded"
            ? "run.completed"
            : result.status === "interrupted"
              ? "run.cancelled"
              : "run.failed";
        this.appendRunEvent(runId, {
          type: eventType,
          summary:
            result.errorSummary ?? (result.status === "succeeded" ? "Run 已完成" : "Run 未完成"),
          payload: result.errorCode ? { errorCode: result.errorCode } : {},
        });
        if (result.errorSummary || result.errorCode)
          this.#setRunError(runId, result.errorCode ?? null, result.errorSummary ?? null);
      }
    } catch (error) {
      this.#failRun(runId, error);
    } finally {
      this.#activeRuns.delete(runId);
    }
  }

  async #waitForApproval(
    runId: string,
    providerKind: ProviderKind,
    request: ExecutionApprovalRequest,
    type: "approval" | "user_input",
  ): Promise<ExecutionApprovalDecision> {
    const approvalId = randomUUID();
    const timestamp = this.#now().toISOString();
    const projectId = this.#projectIdForRun(runId);
    const eventType = type === "approval" ? "approval.requested" : "user.input.requested";
    const summary = redactErrorSummary(request.summary).slice(0, 2_000);
    const safeDetails = safeProviderPayload(request.details);
    const choices = request.choices.map((choice) => safeProviderPayload(choice));
    let resolveWaiter!: (decision: ExecutionApprovalDecision) => void;
    const waiting = new Promise<ExecutionApprovalDecision>((resolve) => {
      resolveWaiter = resolve;
    });
    this.#approvalWaiters.set(approvalId, { runId, resolve: resolveWaiter });
    try {
      const revision = withTransaction(this.#database, () => {
        this.#database
          .prepare(
            "INSERT INTO run_approvals (" +
              "id, run_id, provider_kind, approval_type, summary, details_json, " +
              "choices_json, status, requested_at" +
              ") VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
          )
          .run(
            approvalId,
            runId,
            providerKind,
            type,
            summary,
            JSON.stringify(safeDetails),
            JSON.stringify(choices),
            timestamp,
          );
        this.#appendRunEvent(runId, eventType, summary, { approvalId }, null, timestamp);
        return this.#recordChange(
          "run",
          runId,
          "run.approval_requested",
          { projectId, runId, approvalId },
          timestamp,
        );
      });
      this.#notify(revision);
      return waiting;
    } catch (error) {
      this.#approvalWaiters.delete(approvalId);
      throw error;
    }
  }

  #approvalView(row: z.infer<typeof ApprovalRowSchema>): ExecutionApprovalView {
    return ExecutionApprovalViewSchema.parse({
      id: row.id,
      runId: row.runId,
      providerKind: row.providerKind,
      type: row.type,
      summary: row.summary,
      details: parseJson(row.detailsJson, {}),
      choices: parseJson(row.choicesJson, []),
      status: row.status,
      requestedAt: row.requestedAt,
      resolvedAt: row.resolvedAt,
      resolvedBy: row.resolvedBy,
    });
  }

  #projectIdForRun(runId: string): string {
    const row = this.#database
      .prepare(
        "SELECT tasks.project_id AS projectId FROM runs JOIN tasks ON tasks.id = runs.task_id WHERE runs.id = ?",
      )
      .get(runId) as { projectId: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404, "Run 不存在");
    return row.projectId;
  }

  #setRunError(runId: string, code: string | null, summary: string | null): void {
    this.#database
      .prepare("UPDATE runs SET error_code = ?, error_summary = ?, updated_at = ? WHERE id = ?")
      .run(code, summary?.slice(0, 2_000) ?? null, this.#now().toISOString(), runId);
  }

  #failRun(runId: string, error: unknown): void {
    const code = this.#errorCode(error);
    const summary = redactErrorSummary(
      error instanceof Error ? error.message : "Provider 执行失败",
    );
    try {
      const current = this.readRun(runId);
      if (
        ["succeeded", "failed", "canceled", "interrupted", "disconnected"].includes(current.status)
      )
        return;
      this.#setRunError(runId, code, summary);
      this.appendRunEvent(runId, { type: "run.failed", summary, payload: { errorCode: code } });
    } catch {
      // The run may have been deleted with its task during shutdown.
    }
  }

  #errorCode(error: unknown): string {
    const value =
      error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value) && value.length <= 100)
      return value;
    const message = error instanceof Error ? error.message : "";
    if (/host key|known_hosts|offending key/i.test(message)) return "HOST_KEY_FAILED";
    if (/publickey|ssh.*auth|authentication failed|permission denied.*ssh/i.test(message))
      return "SSH_AUTH_FAILED";
    if (/not found|enoent|未找到|不存在/i.test(message)) return "PROVIDER_NOT_INSTALLED";
    if (/login|credential|unauthorized|auth required/i.test(message))
      return "PROVIDER_AUTH_REQUIRED";
    if (/disconnect|closed|broken pipe/i.test(message)) return "PROVIDER_DISCONNECTED";
    if (/cancel/i.test(message)) return "RUN_INTERRUPTED";
    return "PROVIDER_PROTOCOL_ERROR";
  }

  async readSettings(): Promise<ExecutionSettingsView> {
    const connections = this.listConnections();
    const selectedConnection = connections.find(
      (connection) => connection.host && connection.enabled,
    );
    let providerConnection: ProviderConnectionContext | undefined;
    try {
      providerConnection = selectedConnection
        ? this.#connectionContext(selectedConnection)
        : undefined;
    } catch {
      // A stale or invalid secret reference must not make the settings page unusable.
    }
    const providers = await this.#providers.describe(providerConnection, "/");
    const [sshIdentities, sshAgentAvailable] = await Promise.all([
      this.#identityRegistry.list(),
      isSshAgentAvailable(),
    ]);
    return ExecutionSettingsViewSchema.parse({
      providers: providers.map((provider) => ExecutionProviderDescriptorSchema.parse(provider)),
      connections,
      profiles: this.listProfiles(),
      sshIdentities,
      sshAgentAvailable,
    });
  }

  #appendRunEvent(
    runId: string,
    type: RunEventType,
    summary: string,
    payload: Readonly<Record<string, unknown>>,
    providerEvent: Readonly<Record<string, unknown>> | null,
    timestamp: string,
  ): void {
    const eventType = RunEventTypeSchema.parse(type);
    const next = this.#database
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?")
      .pluck()
      .get(runId) as number;
    this.#database
      .prepare(
        `INSERT INTO run_events (
          id, run_id, seq, event_type, summary, safe_payload_json, provider_event_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        runId,
        next,
        eventType,
        summary.slice(0, 2_000),
        JSON.stringify(safeProviderPayload(payload)),
        providerEvent ? JSON.stringify(safeProviderPayload(providerEvent)) : null,
        timestamp,
      );
  }

  #connectionView(row: z.infer<typeof ConnectionRowSchema>): ConnectionView {
    return ConnectionViewSchema.parse({
      id: row.id,
      name: row.name,
      type: row.type,
      host: row.host,
      port: row.port,
      username: row.username,
      authMode: row.authMode,
      identityRef: row.identityRef,
      knownHostReference: row.knownHostReference,
      status: row.status,
      capabilities: ConnectionCapabilitiesSchema.parse(
        parseJson(row.capabilitiesJson, { providerExecutables: [], protocolModes: [] }),
      ),
      lastHealth: recordToProviderHealth(row.lastHealthJson),
      enabled: row.enabled === 1,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  #profileView(row: z.infer<typeof ProfileRowSchema>): ExecutionProfileView {
    return ExecutionProfileViewSchema.parse({
      id: row.id,
      name: row.name,
      providerKind: row.providerKind,
      connectionId: row.connectionId,
      connectionName: row.connectionName,
      defaultModel: row.defaultModel,
      defaultMode: row.defaultMode,
      defaultReasoningEffort: row.defaultReasoningEffort,
      environmentRefs: z.array(z.string()).parse(parseJson(row.environmentRefsJson, [])),
      enabled: row.enabled === 1,
      health: recordToProviderHealth(row.healthJson),
      capabilities: ProviderCapabilitySchema.parse(
        parseJson(row.capabilitiesJson, {
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
        }),
      ),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  #mappingView(row: z.infer<typeof MappingRowSchema>): WorkspaceMappingView {
    return WorkspaceMappingViewSchema.parse({
      id: row.id,
      projectId: row.projectId,
      connectionId: row.connectionId,
      connectionName: row.connectionName,
      path: row.path,
      isDefault: row.isDefault === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  #mappingViewById(id: string): WorkspaceMappingView {
    const row = MappingRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT mappings.id, mappings.project_id AS projectId, mappings.connection_id AS connectionId,
            connections.name AS connectionName, mappings.path, mappings.is_default AS isDefault,
            mappings.created_at AS createdAt, mappings.updated_at AS updatedAt
          FROM workspace_mappings AS mappings
          JOIN connections ON connections.id = mappings.connection_id WHERE mappings.id = ?`,
        )
        .get(id),
    );
    if (!row.success) throw new AppError("NOT_FOUND", 404, "Workspace Mapping 不存在");
    return this.#mappingView(row.data);
  }

  #readConnection(id: string): ConnectionView {
    const row = ConnectionRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT id, name, type, host, port, username,
        auth_mode AS authMode, identity_ref AS identityRef, known_host_reference AS knownHostReference, status,
        capabilities_json AS capabilitiesJson, last_health_json AS lastHealthJson,
        enabled, version, created_at AS createdAt, updated_at AS updatedAt
        FROM connections WHERE id = ?`,
        )
        .get(id),
    );
    if (!row.success) throw new AppError("NOT_FOUND", 404, "Connection 不存在");
    return this.#connectionView(row.data);
  }

  #readProfile(id: string): ExecutionProfileView {
    const row = ProfileRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT profiles.id, profiles.name, profiles.provider_kind AS providerKind,
        profiles.connection_id AS connectionId, connections.name AS connectionName,
        profiles.default_model AS defaultModel, profiles.default_mode AS defaultMode,
        profiles.default_reasoning_effort AS defaultReasoningEffort,
        profiles.environment_refs_json AS environmentRefsJson,
        profiles.capabilities_json AS capabilitiesJson, profiles.health_json AS healthJson,
        profiles.enabled, profiles.version, profiles.created_at AS createdAt, profiles.updated_at AS updatedAt
        FROM execution_profiles AS profiles JOIN connections ON connections.id = profiles.connection_id
        WHERE profiles.id = ?`,
        )
        .get(id),
    );
    if (!row.success) throw new AppError("NOT_FOUND", 404, "Execution Profile 不存在");
    return this.#profileView(row.data);
  }

  #readMilestone(id: string): MilestoneView {
    const row = MilestoneRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT milestones.id, milestones.project_id AS projectId, milestones.title,
            milestones.description, milestones.status, milestones.target_date AS targetDate,
            COUNT(tasks.id) AS taskCount,
            SUM(CASE WHEN tasks.status IN ('done', 'canceled') THEN 1 ELSE 0 END) AS completedTaskCount,
            milestones.created_at AS createdAt, milestones.updated_at AS updatedAt
          FROM milestones LEFT JOIN tasks ON tasks.milestone_id = milestones.id
          WHERE milestones.id = ? GROUP BY milestones.id`,
        )
        .get(id),
    );
    if (!row.success) throw new AppError("NOT_FOUND", 404, "Milestone 不存在");
    return MilestoneViewSchema.parse({
      ...row.data,
      completedTaskCount: Number(row.data.completedTaskCount ?? 0),
    });
  }

  #assertProject(id: string): void {
    if (
      !this.#database.prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL").get(id)
    )
      throw new AppError("NOT_FOUND", 404, "项目不存在或已归档");
  }

  #assertTask(id: string): void {
    if (!this.#database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id))
      throw new AppError("NOT_FOUND", 404, "任务不存在");
  }

  #validateConnectionInput(input: {
    readonly host: string | null;
    readonly port?: number | null;
    readonly username?: string | null;
    readonly authMode: "identity_file" | "agent";
    readonly identityRef?: string | null;
  }): void {
    if (!input.host || !input.username)
      throw new AppError("INVALID_REQUEST", 400, "SSH Host 和用户名必填");
    if (input.authMode === "identity_file") {
      if (!input.identityRef)
        throw new AppError(
          "SSH_IDENTITY_NOT_FOUND",
          400,
          "Identity File 模式必须从 Identity Catalog 选择一个 key",
        );
      this.#identityRegistry.resolve(input.identityRef);
    } else if (input.identityRef) {
      throw new AppError("INVALID_REQUEST", 400, "SSH Agent 模式不能配置 Identity File 引用");
    }
  }

  #connectionContext(connection: ConnectionView): ProviderConnectionContext {
    const identityPath =
      connection.authMode === "identity_file" && connection.identityRef
        ? this.#identityRegistry.resolve(connection.identityRef).path
        : null;
    return connectionContext(connection, this.#knownHostsFile, identityPath);
  }

  async #testSsh(connection: ConnectionView, workspace: string): Promise<ProviderHealth> {
    const started = Date.now();
    if (connection.authMode === "agent" && !(await isSshAgentAvailable())) {
      return {
        status: "authentication_required",
        version: null,
        message: "SSH Agent 不可用：请检查可访问的 SSH_AUTH_SOCK socket，或改用 Identity File",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
      };
    }
    const result = await runProcessCommand(
      "ssh",
      buildSshArguments({
        host: connection.host ?? "",
        username: connection.username,
        port: connection.port,
        identity:
          connection.authMode === "identity_file" && connection.identityRef
            ? this.#identityRegistry.resolve(connection.identityRef).path
            : null,
        authMode: connection.authMode,
        knownHostsFile: this.#knownHostsFile,
        executable: "sh",
        args: ["-c", 'printf \'%s\\n\' "$(id -un)" "$(uname -s)" "$(uname -m)"'],
        cwd: isAbsolute(workspace) ? workspace : "/",
      }),
    );
    const output = `${result.stdout}${result.stderr}`;
    const hostKeyChanged = /REMOTE HOST IDENTIFICATION HAS CHANGED|offending key/i.test(output);
    const hostKey = /host key verification failed|known_hosts|no .* host key is known/i.test(
      output,
    );
    const passphrase = /passphrase|incorrect passphrase|SSH_KEY_PASSPHRASE_REQUIRED/i.test(output);
    const auth = /permission denied|publickey|authentication failed/i.test(output);
    const status: ProviderHealth["status"] =
      result.exitCode === 0
        ? "ready"
        : passphrase
          ? "key_passphrase_required"
          : hostKeyChanged
            ? "host_key_changed"
            : hostKey
              ? "host_key_untrusted"
              : auth
                ? "authentication_required"
                : "offline";
    const message =
      result.exitCode === 0
        ? `${result.stdout.trim().split(/\r?\n/).filter(Boolean).join(" · ")} · SSH OK`
        : passphrase
          ? "私钥需要 passphrase；请通过 ssh-agent 加载后重试"
          : hostKeyChanged
            ? "SSH Host Key 已改变，连接已阻止"
            : hostKey
              ? "Host Key 未受信任；请扫描并人工核对 SHA256 指纹"
              : auth
                ? "SSH authentication failed"
                : "SSH connection failed";
    return {
      status,
      version:
        result.exitCode === 0
          ? (result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) ?? null)
          : null,
      message,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  }

  async #inspectRemoteWorkspace(connection: ConnectionView, path: string) {
    const result = await this.#runRemoteShell(
      connection,
      'if [ ! -d "$1" ]; then printf "MISSING\\n"; exit 3; fi; cd -- "$1" || exit 4; printf "EXISTS\\n"; pwd -P',
      [path],
      true,
    );
    const lines = result.stdout.trim().split(/\r?\n/);
    if (lines[0] === "MISSING") return { exists: false, canonicalPath: path };
    const marker = lines.indexOf("EXISTS");
    const canonicalPath = lines[marker + 1];
    if (marker < 0 || !canonicalPath || !isAbsolute(canonicalPath))
      throw new AppError("WORKSPACE_NOT_FOUND", 409, "无法确认目标 Host 上的 Workspace 目录");
    return { exists: true, canonicalPath };
  }

  async #runRemoteShell(
    connection: ConnectionView,
    script: string,
    args: readonly string[],
    allowMissingDirectory = false,
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
    if (!connection.host || !connection.username)
      throw new AppError("CONNECTION_OFFLINE", 409, "SSH Host 与用户名尚未配置");
    if (connection.authMode === "agent" && !(await isSshAgentAvailable()))
      throw new AppError(
        "SSH_AGENT_UNAVAILABLE",
        409,
        "SSH Agent 不可用：请检查 socket 挂载与 SSH_AUTH_SOCK，或改用 Identity File",
      );
    const result = await runProcessCommand(
      "ssh",
      buildSshArguments({
        host: connection.host,
        username: connection.username,
        port: connection.port,
        identity:
          connection.authMode === "identity_file" && connection.identityRef
            ? this.#identityRegistry.resolve(connection.identityRef).path
            : null,
        authMode: connection.authMode,
        knownHostsFile: this.#knownHostsFile,
        executable: "sh",
        args: ["-c", script, "devboard", ...args],
        cwd: "/",
      }),
    );
    if (
      result.exitCode === 0 ||
      (allowMissingDirectory && result.stdout.trim().startsWith("MISSING"))
    )
      return result;
    const output = `${result.stderr}\n${result.stdout}`;
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|offending key/i.test(output))
      throw new AppError("HOST_KEY_CHANGED", 409, "SSH Host Key 已改变，连接已阻止");
    if (/host key verification failed|known_hosts|no .* host key is known/i.test(output))
      throw new AppError("HOST_KEY_UNTRUSTED", 409, "SSH Host Key 尚未确认；请扫描并人工核对指纹");
    if (/passphrase|incorrect passphrase/i.test(output))
      throw new AppError(
        "SSH_KEY_PASSPHRASE_REQUIRED",
        409,
        "请使用 ssh-agent 加载带 passphrase 的私钥",
      );
    if (/permission denied|publickey|authentication failed/i.test(output))
      throw new AppError("SSH_AUTH_FAILED", 409, "SSH 认证失败，请检查 Identity File 或 SSH Agent");
    throw new AppError("CONNECTION_OFFLINE", 409, "无法通过 SSH 在目标 Host 上完成操作");
  }

  #recordChange(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
    timestamp: string,
  ): number {
    const result = this.#database
      .prepare(
        `INSERT INTO change_events (aggregate_type, aggregate_id, event_type, safe_payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        aggregateType,
        aggregateId,
        eventType,
        JSON.stringify(safeProviderPayload(payload)),
        timestamp,
      );
    return Number(result.lastInsertRowid);
  }

  #notify(revision: number): void {
    this.#onRevisionCommitted?.(revision);
  }
}
