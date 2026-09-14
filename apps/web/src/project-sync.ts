import {
  ALL_PROJECT_ID,
  TEMPORARY_PROJECT_ID,
  type ProjectKind,
  type ProjectView,
  type SessionView,
  type TaskView,
} from "@lark-codex/contracts";

export function orderProjectViews(projects: readonly ProjectView[]): ProjectView[] {
  const rank = (project: ProjectView) =>
    project.id === ALL_PROJECT_ID ? 0 : project.id === TEMPORARY_PROJECT_ID ? 1 : 2;
  return projects
    .map((project, index) => ({ project, index }))
    .sort((left, right) => rank(left.project) - rank(right.project) || left.index - right.index)
    .map(({ project }) => project);
}

export function visibleProjectKey(project: ProjectView | undefined): string | null {
  return project?.projectKey ?? null;
}

export function canCreateTaskInProject(
  session: SessionView,
  project: ProjectView | undefined,
  projects: readonly ProjectView[] = [],
): boolean {
  if (!project || project.archivedAt) return false;
  if (project.kind === "temporary") return true;
  if (project.kind === "all") {
    return projects.length === 0 || creatableTaskProjects(session, projects).length > 0;
  }
  return project.kind === "codex";
}

export function creatableTaskProjects(
  _session: SessionView,
  projects: readonly ProjectView[],
): ProjectView[] {
  return projects.filter(
    (project) => !project.archivedAt && (project.kind === "temporary" || project.kind === "codex"),
  );
}

export function defaultTaskCreationProjectId(project: ProjectView): string {
  return project.kind === "all" ? TEMPORARY_PROJECT_ID : project.id;
}

export function taskProjectContext(task: TaskView, projectKind: ProjectKind): string | null {
  if (projectKind === "all") return task.projectName;
  if (projectKind === "temporary" && task.originProjectName) {
    return `原项目：${task.originProjectName}`;
  }
  return null;
}

export function reassignableProjects(projects: readonly ProjectView[]): ProjectView[] {
  return projects.filter((project) => project.kind === "codex");
}
