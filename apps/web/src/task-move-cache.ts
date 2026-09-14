import {
  ALL_PROJECT_ID,
  type BoardView,
  type TaskView,
  type TaskWorkspaceView,
} from "@lark-taskboard/contracts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

export interface TaskMoveCacheSnapshot {
  readonly queryKey: QueryKey;
  readonly task: TaskView;
  readonly previousTaskId?: string;
  readonly nextTaskId?: string;
  readonly index: number;
}

export function mergeTaskMove(
  currentTasks: readonly TaskView[],
  optimisticTasks: readonly TaskView[],
  movedTask: TaskView,
): readonly TaskView[] {
  const currentTask = currentTasks.find(({ id }) => id === movedTask.id);
  if (!currentTask) return currentTasks;
  if (currentTask.version > movedTask.version) return currentTasks;
  const tasks = currentTasks.filter(({ id }) => id !== movedTask.id);
  const currentIds = new Set(tasks.map(({ id }) => id));
  const optimisticIndex = optimisticTasks.findIndex(({ id }) => id === movedTask.id);
  const nextTask = optimisticTasks.slice(optimisticIndex + 1).find(({ id }) => currentIds.has(id));
  const previousTask = optimisticTasks
    .slice(0, optimisticIndex)
    .toReversed()
    .find(({ id }) => currentIds.has(id));
  const nextIndex = nextTask ? tasks.findIndex(({ id }) => id === nextTask.id) : -1;
  const previousIndex = previousTask ? tasks.findIndex(({ id }) => id === previousTask.id) : -1;
  const insertionIndex =
    nextIndex >= 0
      ? nextIndex
      : previousIndex >= 0
        ? previousIndex + 1
        : Math.min(currentTasks.indexOf(currentTask), tasks.length);
  return [...tasks.slice(0, insertionIndex), movedTask, ...tasks.slice(insertionIndex)];
}

export function snapshotTaskMoveCaches(
  queryClient: QueryClient,
  taskId: string,
  boardProjectId: string,
): readonly TaskMoveCacheSnapshot[] {
  return queryClient
    .getQueriesData<BoardView>({ queryKey: ["board", boardProjectId], exact: true })
    .flatMap(([queryKey, board]) => {
      if (!board) return [];
      const index = board.tasks.findIndex(({ id }) => id === taskId);
      if (index < 0) return [];
      const task = board.tasks[index];
      if (!task) return [];
      const previousTask = board.tasks[index - 1];
      const nextTask = board.tasks[index + 1];
      return [
        {
          queryKey,
          task,
          index,
          ...(previousTask ? { previousTaskId: previousTask.id } : {}),
          ...(nextTask ? { nextTaskId: nextTask.id } : {}),
        },
      ];
    });
}

export function patchOptimisticBoard(
  queryClient: QueryClient,
  boardProjectId: string,
  tasks: readonly TaskView[],
  movingTaskId: string,
): void {
  queryClient.setQueryData<BoardView>(["board", boardProjectId], (current) => {
    if (!current) return current;
    const optimisticTask = tasks.find(({ id }) => id === movingTaskId);
    const currentTask = current.tasks.find(({ id }) => id === movingTaskId);
    if (!optimisticTask || !currentTask) return current;
    if (currentTask.version > optimisticTask.version) return current;
    const movedTask = {
      ...currentTask,
      status: optimisticTask.status,
      blockedFromStatus: optimisticTask.blockedFromStatus,
    };
    return { ...current, tasks: [...mergeTaskMove(current.tasks, tasks, movedTask)] };
  });
}

export function restoreTaskMoveSnapshot(
  queryClient: QueryClient,
  snapshot: readonly TaskMoveCacheSnapshot[],
): void {
  for (const entry of snapshot) {
    queryClient.setQueryData<BoardView>(entry.queryKey, (current) => {
      if (!current) return current;
      const currentTask = current.tasks.find(({ id }) => id === entry.task.id);
      if (!currentTask || currentTask.version > entry.task.version) return current;
      const tasks = current.tasks.filter(({ id }) => id !== entry.task.id);
      const nextIndex = entry.nextTaskId
        ? tasks.findIndex(({ id }) => id === entry.nextTaskId)
        : -1;
      const previousIndex = entry.previousTaskId
        ? tasks.findIndex(({ id }) => id === entry.previousTaskId)
        : -1;
      const insertionIndex =
        nextIndex >= 0
          ? nextIndex
          : previousIndex >= 0
            ? previousIndex + 1
            : Math.min(entry.index, tasks.length);
      return {
        ...current,
        tasks: [...tasks.slice(0, insertionIndex), entry.task, ...tasks.slice(insertionIndex)],
      };
    });
  }
}

export function applyTaskUpdate(queryClient: QueryClient, settledTask: TaskView): void {
  queryClient.setQueriesData<BoardView>({ queryKey: ["board"] }, (current) => {
    if (!current) return current;
    const currentTask = current.tasks.find(({ id }) => id === settledTask.id);
    if (!currentTask || currentTask.version > settledTask.version) return current;
    return {
      ...current,
      tasks: current.tasks.map((task) => (task.id === settledTask.id ? settledTask : task)),
    };
  });
  queryClient.setQueryData<TaskView>(["task", settledTask.id], (current) =>
    current && current.version > settledTask.version ? current : settledTask,
  );
  queryClient.setQueryData<TaskWorkspaceView>(["workspace", settledTask.id], (current) => {
    if (!current || current.task.version > settledTask.version) return current;
    return { ...current, task: settledTask };
  });
}

export function applySettledTaskMove(
  queryClient: QueryClient,
  boardProjectId: string,
  optimisticTasks: readonly TaskView[],
  settledTask: TaskView,
): void {
  applyTaskUpdate(queryClient, settledTask);
  queryClient.setQueryData<BoardView>(["board", boardProjectId], (current) => {
    if (!current) return current;
    return {
      ...current,
      tasks: [...mergeTaskMove(current.tasks, optimisticTasks, settledTask)],
    };
  });
}

export async function invalidateTaskMoveQueries(
  queryClient: QueryClient,
  boardProjectId: string,
  ownerProjectId: string,
): Promise<void> {
  const projectIds = [...new Set([boardProjectId, ALL_PROJECT_ID, ownerProjectId])];
  await Promise.all(
    projectIds.flatMap((projectId) =>
      (["board", "dashboard"] as const).map((scope) =>
        queryClient.invalidateQueries({ queryKey: [scope, projectId], exact: true }),
      ),
    ),
  );
}
