import { z } from "zod";

import { EntityIdSchema, EntityVersionSchema, IsoTimestampSchema, RevisionSchema } from "./common.js";

/** Provider names stay open so new adapters do not change Project/Task contracts. */
export const ProviderKindSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9._-]*$/);
export const BuiltInProviderKindSchema = z.enum(["codex", "cursor", "grok", "opencode"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export type BuiltInProviderKind = z.infer<typeof BuiltInProviderKindSchema>;

export const ConnectionTypeSchema = z.literal("ssh_host");
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

export const SSHAuthModeSchema = z.enum(["identity_file", "agent"]);
export type SSHAuthMode = z.infer<typeof SSHAuthModeSchema>;
const IdentityReferenceSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((reference) => !reference.includes(".."));

export const ConnectionStatusSchema = z.enum([
  "unknown",
  "checking",
  "online",
  "offline",
  "authentication_required",
  "error",
  "configuration_required",
  "host_key_untrusted",
  "host_key_changed",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ProviderHealthStatusSchema = z.enum([
  "unknown",
  "ready",
  "not_installed",
  "authentication_required",
  "offline",
  "error",
  "host_key_untrusted",
  "host_key_changed",
  "key_passphrase_required",
]);
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>;

export const ProviderCapabilitySchema = z.object({
  streaming: z.boolean(),
  approvals: z.boolean(),
  userInput: z.boolean(),
  cancel: z.boolean(),
  resume: z.boolean(),
  models: z.boolean(),
  reasoningEffort: z.boolean(),
  modes: z.boolean(),
  permissionModes: z.boolean(),
  workspace: z.boolean(),
});
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const ProviderHealthSchema = z.object({
  status: ProviderHealthStatusSchema,
  version: z.string().trim().max(200).nullable(),
  message: z.string().trim().max(2_000).nullable(),
  checkedAt: IsoTimestampSchema,
  latencyMs: z.number().int().nonnegative().nullable(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const SshIdentityDescriptorSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .refine((reference) => !reference.includes("..")),
  name: z.string().trim().min(1).max(160),
  algorithm: z.string().trim().max(100).nullable(),
  fingerprint: z.string().trim().max(200).nullable(),
  encrypted: z.boolean().nullable(),
  usable: z.boolean(),
  warning: z.string().trim().max(500).nullable(),
});
export type SshIdentityDescriptor = z.infer<typeof SshIdentityDescriptorSchema>;

export const ModelDescriptorSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  reasoningEfforts: z.array(z.string().trim().min(1).max(80)),
  modes: z.array(z.string().trim().min(1).max(80)),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const ConnectionCapabilitiesSchema = z.object({
  providerExecutables: z.array(z.string().trim().min(1).max(200)).max(50),
  protocolModes: z.array(z.string().trim().min(1).max(80)).max(50),
});
export type ConnectionCapabilities = z.infer<typeof ConnectionCapabilitiesSchema>;

export const ConnectionViewSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(160),
  type: ConnectionTypeSchema,
  host: z.string().trim().max(255).nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  username: z.string().trim().max(160).nullable(),
  authMode: SSHAuthModeSchema,
  identityRef: IdentityReferenceSchema.nullable(),
  knownHostReference: z.string().trim().min(1).max(255),
  status: ConnectionStatusSchema,
  capabilities: ConnectionCapabilitiesSchema,
  lastHealth: ProviderHealthSchema.nullable(),
  enabled: z.boolean(),
  version: EntityVersionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type ConnectionView = z.infer<typeof ConnectionViewSchema>;

export const CreateConnectionCommandSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  type: ConnectionTypeSchema.default("ssh_host"),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535).nullable().default(null),
  username: z.string().trim().min(1).max(160),
  authMode: SSHAuthModeSchema.default("identity_file"),
  identityRef: IdentityReferenceSchema.nullable().default(null),
  capabilities: ConnectionCapabilitiesSchema.default({ providerExecutables: [], protocolModes: [] }),
  enabled: z.boolean().default(true),
});
export type CreateConnectionCommand = z.infer<typeof CreateConnectionCommandSchema>;

export const UpdateConnectionCommandSchema = z
  .strictObject({
    expectedVersion: EntityVersionSchema,
    name: z.string().trim().min(1).max(160).optional(),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65_535).nullable().optional(),
    username: z.string().trim().max(160).nullable().optional(),
    authMode: SSHAuthModeSchema.optional(),
    identityRef: IdentityReferenceSchema.nullable().optional(),
    capabilities: ConnectionCapabilitiesSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((command) => Object.keys(command).some((key) => key !== "expectedVersion"), {
    message: "至少需要修改一个连接字段",
  });
export type UpdateConnectionCommand = z.infer<typeof UpdateConnectionCommandSchema>;

export const ExecutionProfileViewSchema = z.object({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(160),
  providerKind: ProviderKindSchema,
  connectionId: EntityIdSchema,
  connectionName: z.string().trim().min(1).max(160),
  defaultModel: z.string().trim().max(200).nullable(),
  defaultMode: z.string().trim().max(80).nullable(),
  defaultReasoningEffort: z.string().trim().max(80).nullable(),
  environmentRefs: z.array(z.string().trim().min(1).max(200)).max(100),
  enabled: z.boolean(),
  health: ProviderHealthSchema.nullable(),
  capabilities: ProviderCapabilitySchema,
  version: EntityVersionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type ExecutionProfileView = z.infer<typeof ExecutionProfileViewSchema>;

export const CreateExecutionProfileCommandSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  providerKind: ProviderKindSchema,
  connectionId: EntityIdSchema,
  defaultModel: z.string().trim().max(200).nullable().default(null),
  defaultMode: z.string().trim().max(80).nullable().default(null),
  defaultReasoningEffort: z.string().trim().max(80).nullable().default(null),
  environmentRefs: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  enabled: z.boolean().default(true),
});
export type CreateExecutionProfileCommand = z.infer<typeof CreateExecutionProfileCommandSchema>;

export const UpdateExecutionProfileCommandSchema = z
  .strictObject({
    expectedVersion: EntityVersionSchema,
    name: z.string().trim().min(1).max(160).optional(),
    providerKind: ProviderKindSchema.optional(),
    connectionId: EntityIdSchema.optional(),
    defaultModel: z.string().trim().max(200).nullable().optional(),
    defaultMode: z.string().trim().max(80).nullable().optional(),
    defaultReasoningEffort: z.string().trim().max(80).nullable().optional(),
    environmentRefs: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((command) => Object.keys(command).some((key) => key !== "expectedVersion"), {
    message: "至少需要修改一个执行配置字段",
  });
export type UpdateExecutionProfileCommand = z.infer<typeof UpdateExecutionProfileCommandSchema>;

export const WorkspaceMappingViewSchema = z.object({
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  connectionId: EntityIdSchema,
  connectionName: z.string().trim().min(1).max(160),
  path: z.string().trim().min(1).max(4_096),
  isDefault: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type WorkspaceMappingView = z.infer<typeof WorkspaceMappingViewSchema>;

export const CreateWorkspaceMappingCommandSchema = z.strictObject({
  projectId: EntityIdSchema,
  connectionId: EntityIdSchema,
  path: z.string().trim().min(1).max(4_096),
  isDefault: z.boolean().default(true),
});
export type CreateWorkspaceMappingCommand = z.infer<typeof CreateWorkspaceMappingCommandSchema>;

export const MilestoneStatusSchema = z.enum(["planned", "active", "completed", "canceled"]);
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;
export const MilestoneViewSchema = z.object({
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000),
  status: MilestoneStatusSchema,
  targetDate: z.string().date().nullable(),
  taskCount: z.number().int().nonnegative(),
  completedTaskCount: z.number().int().nonnegative(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type MilestoneView = z.infer<typeof MilestoneViewSchema>;
export const CreateMilestoneCommandSchema = z.strictObject({
  projectId: EntityIdSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(""),
  status: MilestoneStatusSchema.default("planned"),
  targetDate: z.string().date().nullable().default(null),
});
export type CreateMilestoneCommand = z.infer<typeof CreateMilestoneCommandSchema>;

export const RunStatusSchema = z.enum([
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
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const RunEventTypeSchema = z.enum([
  "run.started",
  "run.progress",
  "agent.message",
  "agent.thinking",
  "tool.started",
  "tool.completed",
  "command.started",
  "command.completed",
  "file.changed",
  "approval.requested",
  "approval.resolved",
  "user.input.requested",
  "user.input.resolved",
  "artifact.created",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;
export const RunEventViewSchema = z.object({
  id: EntityIdSchema,
  seq: z.number().int().positive(),
  type: RunEventTypeSchema,
  summary: z.string().max(2_000),
  payload: z.record(z.string(), z.json()),
  providerEvent: z.record(z.string(), z.json()).nullable(),
  createdAt: IsoTimestampSchema,
});
export type RunEventView = z.infer<typeof RunEventViewSchema>;

export const RunViewSchema = z.object({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  executionProfileId: EntityIdSchema.nullable(),
  executionProfileName: z.string().trim().max(160).nullable(),
  providerKind: ProviderKindSchema,
  connectionId: EntityIdSchema.nullable(),
  connectionName: z.string().trim().max(160).nullable(),
  workspace: z.string().trim().max(4_096).nullable(),
  model: z.string().trim().max(200).nullable(),
  mode: z.string().trim().max(80).nullable(),
  permissionMode: z.string().trim().max(120).nullable(),
  reasoningEffort: z.string().trim().max(80).nullable(),
  providerThreadId: z.string().trim().max(500).nullable(),
  providerSessionId: z.string().trim().max(500).nullable(),
  status: RunStatusSchema,
  errorCode: z.string().trim().max(100).nullable(),
  errorSummary: z.string().max(2_000).nullable(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.nullable(),
  finishedAt: IsoTimestampSchema.nullable(),
  events: z.array(RunEventViewSchema),
});
export type RunView = z.infer<typeof RunViewSchema>;
export const RunListViewSchema = z.object({ taskId: EntityIdSchema, runs: z.array(RunViewSchema) });

export const ExecutionApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "canceled",
  "expired",
]);
export type ExecutionApprovalStatus = z.infer<typeof ExecutionApprovalStatusSchema>;
export const ExecutionApprovalViewSchema = z.object({
  id: EntityIdSchema,
  runId: EntityIdSchema,
  providerKind: ProviderKindSchema,
  type: z.string().trim().min(1).max(120),
  summary: z.string().max(2_000),
  details: z.record(z.string(), z.json()),
  choices: z.array(z.record(z.string(), z.json())).max(100),
  status: ExecutionApprovalStatusSchema,
  requestedAt: IsoTimestampSchema,
  resolvedAt: IsoTimestampSchema.nullable(),
  resolvedBy: z.string().trim().max(200).nullable(),
});
export type ExecutionApprovalView = z.infer<typeof ExecutionApprovalViewSchema>;
export const ExecutionApprovalDecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("reject"), reason: z.string().trim().max(2_000).optional() }),
  z.object({ type: z.literal("cancel") }),
  z.object({
    type: z.literal("input"),
    answers: z.record(z.string(), z.array(z.string().max(1_000)).max(20)).max(100),
  }),
]);
export type ExecutionApprovalDecision = z.infer<typeof ExecutionApprovalDecisionSchema>;

export const ExecutionProviderDescriptorSchema = z.object({
  kind: ProviderKindSchema,
  displayName: z.string().trim().min(1).max(160),
  installed: z.boolean(),
  health: ProviderHealthSchema,
  capabilities: ProviderCapabilitySchema,
  models: z.array(ModelDescriptorSchema),
});
export type ExecutionProviderDescriptor = z.infer<typeof ExecutionProviderDescriptorSchema>;
export const ExecutionSettingsViewSchema = z.object({
  providers: z.array(ExecutionProviderDescriptorSchema),
  connections: z.array(ConnectionViewSchema),
  profiles: z.array(ExecutionProfileViewSchema),
  sshIdentities: z.array(SshIdentityDescriptorSchema),
  sshAgentAvailable: z.boolean(),
});
export type ExecutionSettingsView = z.infer<typeof ExecutionSettingsViewSchema>;

export const ProjectExecutionProfileViewSchema = z.object({
  projectId: EntityIdSchema,
  profileId: EntityIdSchema.nullable(),
});
export type ProjectExecutionProfileView = z.infer<typeof ProjectExecutionProfileViewSchema>;

export const UpdateProjectExecutionProfileCommandSchema = z.strictObject({
  profileId: EntityIdSchema.nullable(),
});
export type UpdateProjectExecutionProfileCommand = z.infer<
  typeof UpdateProjectExecutionProfileCommandSchema
>;

export const ExecutionMutationResultSchema = z.object({ revision: RevisionSchema.positive() });
