import { ALL_PROJECT_ID, type BoardView, type TaskView } from "@lark-taskboard/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  applySettledTaskMove,
  applyTaskUpdate,
  invalidateTaskMoveQueries,
  mergeTaskMove,
  patchOptimisticBoard,
  restoreTaskMoveSnapshot,
  snapshotTaskMoveCaches,
} from "./task-move-cache";

const ownerProjectId = "10000000-0000-4000-8000-000000000001";

function task(id: string, status: TaskView["status"], version = 1): TaskView {
  return {
    id,
    identifier: id.toUpperCase(),
    projectId: ownerProjectId,
    projectName: "项目 A",
    originProjectName: null,
    codexThreadState: "none",
    permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
    taskNumber: 1,
    title: id,
    description: "",
    status,
    blockedFromStatus: null,
    priority: "none",
    labels: [],
    assigneeIdentity: null,
    creatorIdentity: null,
    startAt: null,
    dueAt: null,
    recurrence: null,
    developmentContextId: null,
    links: [],
    sortOrder: 1,
    version,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    archivedAt: null,
  };
}

function board(tasks: readonly TaskView[]): BoardView {
  return {
    project: {
      id: ownerProjectId,
      projectKey: "ABC",
      name: "项目 A",
      description: "",
      kind: "codex",
      rootPaths: ["/tmp/a"],
      syncState: "synced",
      membershipRole: "owner",
      version: 1,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
      archivedAt: null,
    },
    tasks: [...tasks],
  };
}

describe("task move cache", () => {
  it("updates detail and all cached boards immediately without replacing newer tasks", () => {
    const queryClient = new QueryClient();
    const before = task("a", "in_review", 1);
    const updated = task("a", "done", 3);
    const other = task("b", "todo", 1);
    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([before, other]));
    queryClient.setQueryData(["board", ownerProjectId], board([before]));
    queryClient.setQueryData(["task", "a"], before);
    applyTaskUpdate(queryClient, updated);
    expect(queryClient.getQueryData<BoardView>(["board", ALL_PROJECT_ID])?.tasks).toEqual([
      updated,
      other,
    ]);
    expect(queryClient.getQueryData<BoardView>(["board", ownerProjectId])?.tasks).toEqual([
      updated,
    ]);
    expect(queryClient.getQueryData(["task", "a"])).toEqual(updated);
    applyTaskUpdate(queryClient, task("a", "todo", 2));
    expect(queryClient.getQueryData<BoardView>(["board", ALL_PROJECT_ID])?.tasks).toEqual([
      updated,
      other,
    ]);
    expect(queryClient.getQueryData(["task", "a"])).toEqual(updated);
    queryClient.clear();
  });
  it("shows the optimistic status and order before the request settles", () => {
    const queryClient = new QueryClient();
    const a = task("a", "todo");
    const b = task("b", "in_progress");
    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([a, b]));

    patchOptimisticBoard(queryClient, ALL_PROJECT_ID, [b, { ...a, status: "in_progress" }], "a");

    expect(
      queryClient
        .getQueryData<BoardView>(["board", ALL_PROJECT_ID])
        ?.tasks.map((item) => [item.id, item.status]),
    ).toEqual([
      ["b", "in_progress"],
      ["a", "in_progress"],
    ]);
  });

  it("restores only the moved task after rejection and preserves concurrent task updates", () => {
    const queryClient = new QueryClient();
    const before = board([task("a", "todo"), task("b", "in_progress")]);
    queryClient.setQueryData(["board", ALL_PROJECT_ID], before);
    queryClient.setQueryData(
      ["board", ownerProjectId],
      board([{ ...task("a", "todo", 5), title: "owner旧值" }, task("b", "in_progress")]),
    );
    const snapshot = snapshotTaskMoveCaches(queryClient, "a", ALL_PROJECT_ID);
    patchOptimisticBoard(queryClient, ALL_PROJECT_ID, [...before.tasks].reverse(), "a");
    queryClient.setQueryData<BoardView>(["board", ALL_PROJECT_ID], (current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((item) =>
              item.id === "b" ? { ...item, title: "并发更新", version: 2 } : item,
            ),
          }
        : current,
    );
    queryClient.setQueryData<BoardView>(["board", ownerProjectId], (current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((item) =>
              item.id === "a" ? { ...item, title: "owner并发更新", version: 6 } : item,
            ),
          }
        : current,
    );

    restoreTaskMoveSnapshot(queryClient, snapshot);

    expect(
      queryClient
        .getQueryData<BoardView>(["board", ALL_PROJECT_ID])
        ?.tasks.map((item) => [item.id, item.title, item.version]),
    ).toEqual([
      ["a", "a", 1],
      ["b", "并发更新", 2],
    ]);
    expect(
      queryClient
        .getQueryData<BoardView>(["board", ownerProjectId])
        ?.tasks.find(({ id }) => id === "a"),
    ).toMatchObject({ title: "owner并发更新", version: 6 });

    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([task("b", "in_progress", 2)]));
    restoreTaskMoveSnapshot(queryClient, snapshot);
    expect(
      queryClient.getQueryData<BoardView>(["board", ALL_PROJECT_ID])?.tasks.map(({ id }) => id),
    ).toEqual(["b"]);
  });

  it("does not roll back a moved task that already has a newer cached version", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["board", ALL_PROJECT_ID],
      board([task("a", "todo", 1), task("b", "in_progress")]),
    );
    const snapshot = snapshotTaskMoveCaches(queryClient, "a", ALL_PROJECT_ID);
    queryClient.setQueryData(
      ["board", ALL_PROJECT_ID],
      board([task("b", "in_progress"), { ...task("a", "done", 3), title: "SSE 新值" }]),
    );

    restoreTaskMoveSnapshot(queryClient, snapshot);

    expect(
      queryClient
        .getQueryData<BoardView>(["board", ALL_PROJECT_ID])
        ?.tasks.map((item) => [item.id, item.status, item.version, item.title]),
    ).toEqual([
      ["b", "in_progress", 1, "b"],
      ["a", "done", 3, "SSE 新值"],
    ]);
  });

  it("patches only the moving task while preserving the cache's current membership and versions", () => {
    const queryClient = new QueryClient();
    const a = task("a", "todo");
    const b = { ...task("b", "in_progress"), title: "并发更新", version: 2 };
    const added = task("added", "in_progress", 4);
    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([a, b, added]));

    patchOptimisticBoard(
      queryClient,
      ALL_PROJECT_ID,
      [task("b", "in_progress"), { ...a, status: "in_progress" }, task("removed", "todo")],
      "a",
    );

    expect(
      queryClient
        .getQueryData<BoardView>(["board", ALL_PROJECT_ID])
        ?.tasks.map((item) => [item.id, item.title, item.version, item.status]),
    ).toEqual([
      ["b", "并发更新", 2, "in_progress"],
      ["a", "a", 1, "in_progress"],
      ["added", "added", 4, "in_progress"],
    ]);
  });

  it("does not patch an optimistic move over a newer cached task", () => {
    const queryClient = new QueryClient();
    const current = { ...task("a", "done", 3), title: "SSE 新值" };
    const b = task("b", "in_progress");
    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([b, current]));

    patchOptimisticBoard(queryClient, ALL_PROJECT_ID, [{ ...task("a", "in_progress", 1) }, b], "a");

    expect(
      queryClient
        .getQueryData<BoardView>(["board", ALL_PROJECT_ID])
        ?.tasks.map((item) => [item.id, item.status, item.version, item.title]),
    ).toEqual([
      ["b", "in_progress", 1, "b"],
      ["a", "done", 3, "SSE 新值"],
    ]);
  });

  it("applies the server task version without losing concurrent additions or reviving removals", () => {
    const queryClient = new QueryClient();
    const a = task("a", "todo");
    const b = task("b", "in_progress");
    const added = { ...task("added", "in_progress"), version: 4 };
    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([a, b, added]));

    applySettledTaskMove(
      queryClient,
      ALL_PROJECT_ID,
      [b, { ...a, status: "in_progress" }, task("removed", "in_progress")],
      {
        ...a,
        status: "in_progress",
        version: 2,
        sortOrder: 2,
      },
    );

    expect(
      queryClient
        .getQueryData<BoardView>(["board", ALL_PROJECT_ID])
        ?.tasks.map((item) => [item.id, item.version]),
    ).toEqual([
      ["b", 1],
      ["a", 2],
      ["added", 4],
    ]);

    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([b, added]));
    applySettledTaskMove(queryClient, ALL_PROJECT_ID, [b, a], { ...a, version: 2 });
    expect(
      queryClient.getQueryData<BoardView>(["board", ALL_PROJECT_ID])?.tasks.map(({ id }) => id),
    ).toEqual(["b", "added"]);
  });

  it("ignores a settled response older than the cached task version", () => {
    const queryClient = new QueryClient();
    const current = { ...task("a", "done", 3), title: "SSE 新值" };
    const b = task("b", "in_progress");
    queryClient.setQueryData(["board", ALL_PROJECT_ID], board([b, current]));

    applySettledTaskMove(queryClient, ALL_PROJECT_ID, [{ ...task("a", "in_progress", 1) }, b], {
      ...task("a", "in_progress", 2),
      title: "旧成功响应",
    });

    expect(
      queryClient
        .getQueryData<BoardView>(["board", ALL_PROJECT_ID])
        ?.tasks.map((item) => [item.id, item.status, item.version, item.title]),
    ).toEqual([
      ["b", "in_progress", 1, "b"],
      ["a", "done", 3, "SSE 新值"],
    ]);
  });

  it("keeps a newer displayed task instead of applying an older optimistic move", () => {
    const b = task("b", "in_progress");
    const current = { ...task("a", "done", 3), title: "SSE 新值" };

    const displayed = mergeTaskMove([b, current], [{ ...task("a", "in_progress", 1) }, b], {
      ...task("a", "in_progress", 2),
      title: "旧乐观值",
    });

    expect(displayed.map((item) => [item.id, item.status, item.version, item.title])).toEqual([
      ["b", "in_progress", 1, "b"],
      ["a", "done", 3, "SSE 新值"],
    ]);
  });

  it("invalidates the current, all-project and owner board caches", async () => {
    const queryClient = new QueryClient();
    for (const projectId of ["current-scope", ALL_PROJECT_ID, ownerProjectId]) {
      queryClient.setQueryData(["board", projectId], board([]));
      queryClient.setQueryData(["dashboard", projectId], { totalTasks: 0 });
    }

    await invalidateTaskMoveQueries(queryClient, "current-scope", ownerProjectId);

    for (const projectId of ["current-scope", ALL_PROJECT_ID, ownerProjectId]) {
      expect(queryClient.getQueryState(["board", projectId])?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(["dashboard", projectId])?.isInvalidated).toBe(true);
    }
  });
});
