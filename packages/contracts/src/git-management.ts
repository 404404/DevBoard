import { z } from "zod";

const BranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      !name.startsWith("-") &&
      ![...name].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ),
    "分支名称无效",
  );
export const GitCreationOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("terminal"), createdAt: z.string().optional() }),
  z.object({
    kind: z.literal("user"),
    userKey: z.string(),
    userName: z.string(),
    createdAt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("codex"),
    threadId: z.string().uuid(),
    threadTitle: z.string().optional(),
    createdAt: z.string().optional(),
  }),
]);
export type GitCreationOrigin = z.infer<typeof GitCreationOriginSchema>;
export const GitOriginResourceSchema = z.object({
  threadId: z.string().uuid().optional(),
  key: z.string(),
  kind: z.enum(["branch", "worktree"]),
  branch: z.string().nullable(),
  path: z.string().nullable(),
  createdAt: z.string(),
});
export const GitOriginLookupSchema = z.object({
  mainPath: z.string(),
  resources: z.array(GitOriginResourceSchema).max(500),
});
export const GitOriginLookupResultSchema = z.record(z.string(), GitCreationOriginSchema);
export type GitOriginLookup = z.infer<typeof GitOriginLookupSchema>;
export const GitEntrySchema = z.object({
  branch: z.string().nullable(),
  headSha: z.string(),
  path: z.string().nullable(),
  isMain: z.boolean(),
  isCurrent: z.boolean(),
  dirty: z.boolean().nullable(),
  locked: z.boolean(),
  taskCount: z.number().int().nonnegative(),
  deleteReason: z.string().nullable(),
  branchOrigin: GitCreationOriginSchema.optional(),
  worktreeOrigin: GitCreationOriginSchema.optional(),
});
export const GitManagementViewSchema = z.object({
  mainPath: z.string(),
  currentBranch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  entries: z.array(GitEntrySchema),
});
export const CreateGitResourceCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("branch"),
    branch: BranchNameSchema,
    baseBranch: BranchNameSchema,
    codexThreadId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal("worktree"),
    branch: BranchNameSchema,
    baseBranch: BranchNameSchema.optional(),
    directoryName: z
      .string()
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "目录名称请使用小写字母、数字和连字符"),
    existingBranch: z.boolean().optional(),
    codexThreadId: z.string().uuid().optional(),
  }),
]);
export const DeleteGitResourceCommandSchema = z
  .object({
    branch: BranchNameSchema.nullable(),
    path: z.string().min(1).nullable(),
    expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  })
  .refine((command) => command.branch !== null || command.path !== null);
export type GitEntry = z.infer<typeof GitEntrySchema>;
export type GitManagementView = z.infer<typeof GitManagementViewSchema>;
export type CreateGitResourceCommand = z.infer<typeof CreateGitResourceCommandSchema>;
export type DeleteGitResourceCommand = z.infer<typeof DeleteGitResourceCommandSchema>;
