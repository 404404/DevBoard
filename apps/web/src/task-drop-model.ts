import type { TaskStatus, TaskView } from "@lark-taskboard/contracts";

import type { ActiveBoardStatus } from "./task-status";
import {
  canDropTaskBetweenStatuses,
  displayColumnForTask,
  targetStatusForTaskDrop,
} from "./task-status";

export type TaskDropPosition = "before" | "after";

export interface TaskDropInput {
  readonly activeTaskId: string;
  readonly targetColumn: ActiveBoardStatus;
  readonly overTaskId?: string;
  readonly position?: TaskDropPosition;
}

export interface TaskDropPlan {
  readonly task: TaskView;
  readonly tasks: readonly TaskView[];
  readonly targetStatus: TaskStatus;
  readonly beforeTaskId?: string;
  readonly afterTaskId?: string;
}

export interface TaskMoveCommandInput {
  readonly expectedVersion: number;
  readonly targetStatus: TaskStatus;
  readonly boardProjectId: string;
  readonly beforeTaskId?: string;
  readonly afterTaskId?: string;
}

export function dropPositionFromRects(
  active: { readonly top: number; readonly height: number },
  over: { readonly top: number; readonly height: number },
): TaskDropPosition {
  return active.top + active.height / 2 > over.top + over.height / 2 ? "after" : "before";
}

export function planTaskDrop(
  tasks: readonly TaskView[],
  input: TaskDropInput,
): TaskDropPlan | null {
  const task = tasks.find(({ id }) => id === input.activeTaskId);
  if (!task) return null;

  const sourceColumn = displayColumnForTask(task);
  if (!sourceColumn || !canDropTaskBetweenStatuses(sourceColumn, input.targetColumn)) return null;

  const targetTasks = tasks.filter(
    (candidate) =>
      candidate.id !== task.id && displayColumnForTask(candidate) === input.targetColumn,
  );
  let insertionIndex = targetTasks.length;
  if (input.overTaskId) {
    const overIndex = targetTasks.findIndex(({ id }) => id === input.overTaskId);
    if (overIndex < 0) return null;
    insertionIndex = overIndex + (input.position === "after" ? 1 : 0);
  }

  const targetStatus = targetStatusForTaskDrop(task, input.targetColumn);
  const optimisticTask: TaskView = {
    ...task,
    status: targetStatus,
    blockedFromStatus: targetStatus === "blocked" ? task.blockedFromStatus : null,
  };
  const remaining = tasks.filter(({ id }) => id !== task.id);
  const beforeTask = targetTasks[insertionIndex];
  const previousTask = insertionIndex > 0 ? targetTasks[insertionIndex - 1] : undefined;
  let globalInsertionIndex = remaining.length;
  if (beforeTask) {
    globalInsertionIndex = remaining.findIndex(({ id }) => id === beforeTask.id);
  } else if (previousTask) {
    globalInsertionIndex = remaining.findIndex(({ id }) => id === previousTask.id) + 1;
  }
  const optimisticTasks = [
    ...remaining.slice(0, globalInsertionIndex),
    optimisticTask,
    ...remaining.slice(globalInsertionIndex),
  ];
  const orderChanged = optimisticTasks.some(
    (candidate, index) => candidate.id !== tasks[index]?.id,
  );
  if (!orderChanged && targetStatus === task.status) return null;

  return {
    task,
    tasks: optimisticTasks,
    targetStatus,
    ...(beforeTask ? { beforeTaskId: beforeTask.id } : {}),
  };
}

export function createTaskMoveCommand(
  plan: TaskDropPlan,
  boardProjectId: string,
): TaskMoveCommandInput {
  return {
    expectedVersion: plan.task.version,
    targetStatus: plan.targetStatus,
    boardProjectId,
    ...(plan.beforeTaskId ? { beforeTaskId: plan.beforeTaskId } : {}),
    ...(plan.afterTaskId ? { afterTaskId: plan.afterTaskId } : {}),
  };
}
