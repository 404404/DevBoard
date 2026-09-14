import type { TaskStatus, TaskView } from "@lark-codex/contracts";

export const TASK_STATUS_ORDER = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const satisfies readonly TaskStatus[];

export const ACTIVE_BOARD_STATUSES = ["backlog", "todo", "in_progress", "in_review"] as const;

export type ActiveBoardStatus = (typeof ACTIVE_BOARD_STATUSES)[number];

export const FILTERABLE_TASK_STATUSES = TASK_STATUS_ORDER;

export const ARCHIVE_STATUSES = ["done", "canceled"] as const;

export type TaskStatusSymbol =
  | "lightbulb"
  | "circle"
  | "circle.lefthalf.filled"
  | "eye"
  | "exclamationmark.octagon.fill"
  | "checkmark.circle.fill"
  | "xmark.circle.fill";

export const TASK_STATUS_META: Readonly<
  Record<TaskStatus, { readonly label: string; readonly symbol: TaskStatusSymbol }>
> = {
  backlog: { label: "待立项", symbol: "lightbulb" },
  todo: { label: "待处理", symbol: "circle" },
  in_progress: { label: "处理中", symbol: "circle.lefthalf.filled" },
  in_review: { label: "待验收", symbol: "eye" },
  blocked: { label: "已阻塞", symbol: "exclamationmark.octagon.fill" },
  done: { label: "已完成", symbol: "checkmark.circle.fill" },
  canceled: { label: "已取消", symbol: "xmark.circle.fill" },
};

export function canDropTaskBetweenStatuses(
  from: ActiveBoardStatus,
  to: ActiveBoardStatus,
): boolean {
  return Math.abs(ACTIVE_BOARD_STATUSES.indexOf(from) - ACTIVE_BOARD_STATUSES.indexOf(to)) <= 1;
}

export function displayColumnForTask(task: TaskView): ActiveBoardStatus | null {
  if (task.status === "blocked") {
    return task.blockedFromStatus;
  }
  return (ACTIVE_BOARD_STATUSES as readonly TaskStatus[]).includes(task.status)
    ? (task.status as ActiveBoardStatus)
    : null;
}

export function canSelectTaskStatus(task: TaskView, target: TaskStatus): boolean {
  if (target === task.status) return true;
  const column = displayColumnForTask(task);
  if (!column || !(ACTIVE_BOARD_STATUSES as readonly TaskStatus[]).includes(target)) return false;
  return canDropTaskBetweenStatuses(column, target as ActiveBoardStatus);
}

export function targetStatusForTaskDrop(
  task: TaskView,
  targetColumn: ActiveBoardStatus,
): TaskStatus {
  return task.status === "blocked" && displayColumnForTask(task) === targetColumn
    ? "blocked"
    : targetColumn;
}

export function groupTasksForWorkspace(tasks: readonly TaskView[]) {
  const active: Record<ActiveBoardStatus, TaskView[]> = {
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
  };
  const archive: Record<(typeof ARCHIVE_STATUSES)[number], TaskView[]> = {
    done: [],
    canceled: [],
  };

  for (const task of tasks) {
    const column = displayColumnForTask(task);
    if (column) active[column].push(task);
    else if (task.status === "done" || task.status === "canceled") archive[task.status].push(task);
  }

  return { active, archive } as const;
}
