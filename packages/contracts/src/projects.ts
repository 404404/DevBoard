import { z } from "zod";

import { EntityIdSchema, EntityVersionSchema, IsoTimestampSchema } from "./common.js";
import { ActorRoleSchema, ProjectMemberRoleSchema } from "./domain.js";
import { UserIdentityRefSchema, IdentityRefSchema } from "./identity.js";
import { GlobalLabelViewSchema } from "./labels.js";

export const ProjectKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{1,5}$/, "项目 Key 必须是 1～5 个大写英文字母");
const LegacyProjectKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[A-Z][A-Z0-9-]*$/);

export const ProjectNameSchema = z.string().trim().min(1).max(120);
export const ProjectDescriptionSchema = z.string().max(20_000);
export const ProjectKindSchema = z.enum(["all", "temporary", "codex", "managed"]);
export const LocalProjectKindSchema = z.enum(["legacy", "codex", "system"]);
export const ProjectSyncStateSchema = z.enum(["synced", "stale"]);
export const ProjectRootPathSchema = z.string().trim().min(1).max(4_096);

export const ALL_PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";
export const TEMPORARY_PROJECT_ID = "00000000-0000-4000-8000-0000000000a2";

export const CreateProjectCommandSchema = z.object({
  projectKey: ProjectKeySchema,
  name: ProjectNameSchema,
  description: ProjectDescriptionSchema.default(""),
});

export const UpdateProjectCommandSchema = z
  .object({
    expectedVersion: EntityVersionSchema,
    name: ProjectNameSchema.optional(),
    description: ProjectDescriptionSchema.optional(),
  })
  .refine((command) => command.name !== undefined || command.description !== undefined, {
    message: "至少需要修改一个项目字段",
  });

export const ArchiveProjectCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
});

export const RegisterWorkspaceCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
  absolutePath: z.string().trim().min(1).max(4_096),
});

export const LocalProjectViewSchema = z.object({
  id: EntityIdSchema,
  projectKey: z.union([ProjectKeySchema, LegacyProjectKeySchema]).nullable(),
  name: ProjectNameSchema,
  description: ProjectDescriptionSchema,
  kind: LocalProjectKindSchema.default("legacy"),
  rootPaths: z.array(ProjectRootPathSchema).default([]),
  syncState: ProjectSyncStateSchema.default("synced"),
  workspaceRealpath: z.string().min(1).nullable(),
  version: EntityVersionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  archivedAt: IsoTimestampSchema.nullable(),
});

const ProjectViewBaseSchema = LocalProjectViewSchema.omit({
  workspaceRealpath: true,
  kind: true,
  projectKey: true,
}).extend({
  membershipRole: ProjectMemberRoleSchema.nullable(),
});

export const ProjectViewSchema = z.discriminatedUnion("kind", [
  ProjectViewBaseSchema.extend({ kind: z.literal("all"), projectKey: z.null() }),
  ProjectViewBaseSchema.extend({ kind: z.literal("temporary"), projectKey: z.literal("TEMP") }),
  ProjectViewBaseSchema.extend({ kind: z.literal("codex"), projectKey: ProjectKeySchema }),
  ProjectViewBaseSchema.extend({
    kind: z.literal("managed"),
    projectKey: z.union([ProjectKeySchema, LegacyProjectKeySchema]),
  }),
]);

export const TaskAssigneeCandidateSchema = z.object({
  identity: UserIdentityRefSchema,
  name: z.string().trim().min(1).max(120),
  avatarUrl: z.url().nullable(),
  actorRole: ActorRoleSchema,
  projectRole: ProjectMemberRoleSchema.nullable(),
});

export const TaskRelationCandidateSchema = z.object({
  id: EntityIdSchema,
  identifier: z.string().min(1),
  title: z.string().trim().min(1).max(500),
});

export const DevelopmentContextKindSchema = z.enum(["branch", "worktree"]);

export const LocalDevelopmentContextViewSchema = z.object({
  id: EntityIdSchema,
  kind: DevelopmentContextKindSchema,
  label: z.string().min(1),
  branch: z.string().min(1).nullable(),
  gitRef: z.string().min(1).nullable(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  worktreeRealpath: z.string().min(1).nullable(),
  executable: z.boolean(),
  active: z.boolean(),
  scannedAt: IsoTimestampSchema,
});

export const ProjectTaskCreationOptionsViewSchema = z.object({
  projectId: EntityIdSchema,
  currentIdentity: IdentityRefSchema,
  assignees: z.array(TaskAssigneeCandidateSchema),
  labels: z.array(GlobalLabelViewSchema),
  developmentContexts: z.array(LocalDevelopmentContextViewSchema),
  defaultDevelopmentContext: z.object({
    id: EntityIdSchema.nullable(),
    label: z.string().trim().min(1),
    branch: z.string().trim().min(1).nullable(),
  }),
  relationCandidates: z.array(TaskRelationCandidateSchema),
  attachmentMaxBytes: z.number().int().positive(),
});

export const GitRepositoryStateSchema = z.object({
  branch: z.string().min(1).nullable(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  dirty: z.boolean(),
});

export const WorkspaceRegistrationResultSchema = z.object({
  project: LocalProjectViewSchema,
  repository: GitRepositoryStateSchema,
  contexts: z.array(LocalDevelopmentContextViewSchema),
});

export const ExecutionContextSchema = z.object({
  projectId: EntityIdSchema,
  developmentContextId: EntityIdSchema.nullable(),
  cwd: z.string().min(1),
  branch: z.string().min(1).nullable(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
});

export type CreateProjectCommand = z.infer<typeof CreateProjectCommandSchema>;
export type UpdateProjectCommand = z.infer<typeof UpdateProjectCommandSchema>;
export type ArchiveProjectCommand = z.infer<typeof ArchiveProjectCommandSchema>;
export type RegisterWorkspaceCommand = z.infer<typeof RegisterWorkspaceCommandSchema>;
export type ProjectKind = z.infer<typeof ProjectKindSchema>;
export type LocalProjectKind = z.infer<typeof LocalProjectKindSchema>;
export type ProjectSyncState = z.infer<typeof ProjectSyncStateSchema>;
export type LocalProjectView = z.infer<typeof LocalProjectViewSchema>;
export type ProjectView = z.infer<typeof ProjectViewSchema>;
export type TaskAssigneeCandidate = z.infer<typeof TaskAssigneeCandidateSchema>;
export type TaskRelationCandidate = z.infer<typeof TaskRelationCandidateSchema>;
export type LocalDevelopmentContextView = z.infer<typeof LocalDevelopmentContextViewSchema>;
export type ProjectTaskCreationOptionsView = z.infer<typeof ProjectTaskCreationOptionsViewSchema>;
export type GitRepositoryState = z.infer<typeof GitRepositoryStateSchema>;
export type WorkspaceRegistrationResult = z.infer<typeof WorkspaceRegistrationResultSchema>;
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;
