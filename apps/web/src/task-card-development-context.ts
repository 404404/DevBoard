import type { TaskView, ProjectTaskCreationOptionsView } from "@lark-codex/contracts";

export function taskCardDevelopmentContext(
  task: Pick<TaskView, "developmentContextId">,
  options: Pick<
    ProjectTaskCreationOptionsView,
    "developmentContexts" | "defaultDevelopmentContext"
  >,
) {
  const context = task.developmentContextId
    ? options.developmentContexts.find((item) => item.id === task.developmentContextId)
    : undefined;
  if (task.developmentContextId && !context) return { branch: null, label: "分支不可用" };
  return {
    branch:
      context?.branch ??
      (!task.developmentContextId ? options.defaultDevelopmentContext.branch : null),
    label: "未绑定分支",
  };
}
