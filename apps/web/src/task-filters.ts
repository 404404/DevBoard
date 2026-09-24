import type { TaskPriority, TaskStatus, TaskView } from "@codexboard/contracts";

export interface TaskFilters {
  readonly query: string;
  readonly statuses: ReadonlySet<TaskStatus>;
  readonly priorities: ReadonlySet<TaskPriority>;
  readonly labels: ReadonlySet<string>;
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  query: "",
  statuses: new Set(),
  priorities: new Set(),
  labels: new Set(),
};

export interface AvailableFilterOptions {
  readonly statuses: ReadonlySet<TaskStatus>;
  readonly priorities: ReadonlySet<TaskPriority>;
  readonly labels: ReadonlySet<string>;
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function matchesQuery(task: TaskView, query: string): boolean {
  if (!query) return true;
  if (
    task.identifier.toLocaleLowerCase("zh-CN").includes(query) ||
    task.title.toLocaleLowerCase("zh-CN").includes(query) ||
    task.description.toLocaleLowerCase("zh-CN").includes(query)
  ) {
    return true;
  }
  return task.labels.some((label) => label.toLocaleLowerCase("zh-CN").includes(query));
}

export function matchesTask(task: TaskView, filters: TaskFilters): boolean {
  return (
    matchesQuery(task, normalizeQuery(filters.query)) &&
    (!filters.statuses.size || filters.statuses.has(task.status)) &&
    (!filters.priorities.size || filters.priorities.has(task.priority)) &&
    (!filters.labels.size || task.labels.some((label) => filters.labels.has(label)))
  );
}

export function filterTasks(tasks: readonly TaskView[], filters: TaskFilters): TaskView[] {
  const query = normalizeQuery(filters.query);
  return tasks.filter(
    (task) =>
      matchesQuery(task, query) &&
      (!filters.statuses.size || filters.statuses.has(task.status)) &&
      (!filters.priorities.size || filters.priorities.has(task.priority)) &&
      (!filters.labels.size || task.labels.some((label) => filters.labels.has(label))),
  );
}

export function availableFilterOptions(tasks: readonly TaskView[]): AvailableFilterOptions {
  return {
    statuses: new Set(tasks.map((task) => task.status)),
    priorities: new Set(tasks.map((task) => task.priority)),
    labels: new Set(tasks.flatMap((task) => task.labels)),
  };
}
