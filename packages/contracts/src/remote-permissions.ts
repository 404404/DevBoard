import { z } from "zod";

const PathText = z.string().min(1).max(10_000);
const SpecialPath = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("root") }),
  z.strictObject({ kind: z.literal("minimal") }),
  z.strictObject({ kind: z.literal("tmpdir") }),
  z.strictObject({ kind: z.literal("slash_tmp") }),
  z.strictObject({ kind: z.literal("project_roots"), subpath: PathText.nullable() }),
]);
const PermissionPath = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("path"), path: PathText }),
  z.strictObject({ type: z.literal("glob_pattern"), pattern: PathText }),
  z.strictObject({ type: z.literal("special"), value: SpecialPath }),
]);
export const RemotePermissionProfileSchema = z.strictObject({
  network: z.strictObject({ enabled: z.boolean().nullable() }).nullish(),
  fileSystem: z
    .strictObject({
      read: z.array(PathText).max(1000).nullish(),
      write: z.array(PathText).max(1000).nullish(),
      globScanMaxDepth: z.number().int().nonnegative().optional(),
      entries: z
        .array(z.strictObject({ path: PermissionPath, access: z.enum(["read", "write", "deny"]) }))
        .max(1000)
        .optional(),
    })
    .nullish(),
});

export function describeRemotePermissions(value: unknown): string | null {
  const parsed = RemotePermissionProfileSchema.safeParse(value);
  if (!parsed.success) return null;
  const { network, fileSystem } = parsed.data;
  const details: string[] = [];
  if (network?.enabled != null) details.push(network.enabled ? "访问网络" : "不允许访问网络");
  for (const path of fileSystem?.read ?? []) details.push(`读取：${path}`);
  for (const path of fileSystem?.write ?? []) details.push(`写入：${path}`);
  for (const { path, access } of fileSystem?.entries ?? []) {
    let label: string;
    if (path.type === "path") label = path.path;
    else if (path.type === "glob_pattern") label = `匹配 ${path.pattern}`;
    else {
      const special = path.value;
      const names = {
        root: "整个文件系统",
        minimal: "运行所需的最小系统路径",
        tmpdir: "系统临时目录",
        slash_tmp: "/tmp",
        project_roots: "项目目录",
      };
      label =
        names[special.kind] +
        (special.kind === "project_roots" && special.subpath ? `/${special.subpath}` : "");
    }
    details.push(`${{ read: "读取", write: "写入", deny: "禁止访问" }[access]}：${label}`);
  }
  if (fileSystem?.globScanMaxDepth != null)
    details.push(`路径匹配扫描深度：${fileSystem.globScanMaxDepth}`);
  return details.join("\n") || "未申请额外权限";
}
