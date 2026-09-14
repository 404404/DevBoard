import type { ProjectKind, ProjectView } from "@lark-codex/contracts";

import type { SfSymbolName } from "./sf-symbol-names";

export function projectSymbolForKind(kind: ProjectKind): SfSymbolName {
  return kind === "all" ? "square.3.layers.3d" : kind === "temporary" ? "clock" : "folder";
}

export function filterProjectOptions(
  projects: readonly ProjectView[],
  query: string,
): readonly ProjectView[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return normalized
    ? projects.filter((project) => project.name.toLocaleLowerCase("zh-CN").includes(normalized))
    : [...projects];
}
