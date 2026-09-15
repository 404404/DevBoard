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

export function matchesTask(task: TaskView, filters: TaskFilters): boolean {
  const query = filters.query.trim().toLocaleLowerCase("zh-CN");
  const haystack = [task.identifier, task.title, task.description, ...task.labels]
    .join("\n")
    .toLocaleLowerCase("zh-CN");
  return (
    (!query || haystack.includes(query)) &&
    (!filters.statuses.size || filters.statuses.has(task.status)) &&
    (!filters.priorities.size || filters.priorities.has(task.priority)) &&
    (!filters.labels.size || task.labels.some((label) => filters.labels.has(label)))
  );
}

export function filterTasks(tasks: readonly TaskView[], filters: TaskFilters): TaskView[] {
  return tasks.filter((task) => matchesTask(task, filters));
}

export function availableFilterOptions(tasks: readonly TaskView[]): AvailableFilterOptions {
  return {
    statuses: new Set(tasks.map((task) => task.status)),
    priorities: new Set(tasks.map((task) => task.priority)),
    labels: new Set(tasks.flatMap((task) => task.labels)),
  };
}
