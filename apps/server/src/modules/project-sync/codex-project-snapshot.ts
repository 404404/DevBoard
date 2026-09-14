import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

const CodexProjectSchema = z.object({
  codexProjectId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  rootPaths: z
    .array(
      z.string().trim().min(1).max(4_096).refine(isAbsolute, "Codex 项目源文件夹必须使用绝对路径"),
    )
    .min(1)
    .refine((paths) => new Set(paths).size === paths.length, "Codex 项目源文件夹不能重复"),
  position: z.number().int().nonnegative(),
});

export const CodexProjectSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    projects: z.array(CodexProjectSchema).max(10_000),
  })
  .superRefine((snapshot, context) => {
    const ids = new Set<string>();
    for (const [position, project] of snapshot.projects.entries()) {
      if (project.position !== position) {
        context.addIssue({
          code: "custom",
          path: ["projects", position, "position"],
          message: "Codex 项目顺序必须连续且与数组位置一致",
        });
      }
      if (ids.has(project.codexProjectId)) {
        context.addIssue({
          code: "custom",
          path: ["projects", position, "codexProjectId"],
          message: "Codex 项目 ID 不能重复",
        });
      }
      ids.add(project.codexProjectId);
    }
  });

export type CodexProjectSnapshot = z.infer<typeof CodexProjectSnapshotSchema>;
export type CodexProjectSnapshotEntry = CodexProjectSnapshot["projects"][number];

export class ProjectSnapshotError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Codex 项目快照不可用");
    this.name = "ProjectSnapshotError";
    this.code = code;
  }
}

export function readCodexProjectSnapshot(snapshotFile: string): CodexProjectSnapshot {
  if (!isAbsolute(snapshotFile)) throw new ProjectSnapshotError("PROJECT_SNAPSHOT_PATH_INVALID");
  const path = resolve(snapshotFile);
  let source: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
      throw new ProjectSnapshotError("PROJECT_SNAPSHOT_FILE_UNSAFE");
    }
    source = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof ProjectSnapshotError) throw error;
    throw new ProjectSnapshotError("PROJECT_SNAPSHOT_UNAVAILABLE");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ProjectSnapshotError("PROJECT_SNAPSHOT_INVALID");
  }
  const result = CodexProjectSnapshotSchema.safeParse(value);
  if (!result.success) throw new ProjectSnapshotError("PROJECT_SNAPSHOT_INVALID");
  return result.data;
}
