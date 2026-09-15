import type { TaskView } from "@codexboard/contracts";
import { describe, expect, it } from "vitest";

import { createTaskMoveCommand, dropPositionFromRects, planTaskDrop } from "./task-drop-model";

function task(
  id: string,
  status: TaskView["status"] = "todo",
  overrides: Partial<TaskView> = {},
): TaskView {
  return {
    id,
    identifier: id.toUpperCase(),
    projectId: "10000000-0000-4000-8000-000000000001",
    projectName: "项目 A",
    originProjectName: null,
    codexThreadState: "none",
    permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
    taskNumber: 1,
    title: id,
    description: "",
    status,
    blockedFromStatus: status === "blocked" ? "todo" : null,
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
    version: 3,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("task drop model", () => {
  it("moves A below B when released over the lower half of B", () => {
    const plan = planTaskDrop([task("a"), task("b"), task("c")], {
      activeTaskId: "a",
      targetColumn: "todo",
      overTaskId: "b",
      position: "after",
    });

    expect(plan?.tasks.map(({ id }) => id)).toEqual(["b", "a", "c"]);
    expect(plan?.beforeTaskId).toBe("c");
    expect(plan?.afterTaskId).toBeUndefined();
  });

  it("moves C above A when released over the upper half of A", () => {
    const plan = planTaskDrop([task("a"), task("b"), task("c")], {
      activeTaskId: "c",
      targetColumn: "todo",
      overTaskId: "a",
      position: "before",
    });

    expect(plan?.tasks.map(({ id }) => id)).toEqual(["c", "a", "b"]);
    expect(plan?.beforeTaskId).toBe("a");
  });

  it("uses an unanchored request for a tail insertion and a before anchor for the head", () => {
    const tasks = [task("a"), task("b"), task("c")];

    const tail = planTaskDrop(tasks, {
      activeTaskId: "a",
      targetColumn: "todo",
      overTaskId: "c",
      position: "after",
    });
    const head = planTaskDrop(tasks, {
      activeTaskId: "c",
      targetColumn: "todo",
      overTaskId: "a",
      position: "before",
    });

    expect(tail?.tasks.map(({ id }) => id)).toEqual(["b", "c", "a"]);
    expect(tail?.beforeTaskId).toBeUndefined();
    expect(tail?.afterTaskId).toBeUndefined();
    expect(head?.tasks.map(({ id }) => id)).toEqual(["c", "a", "b"]);
    expect(head?.beforeTaskId).toBe("a");
  });

  it("moves across adjacent columns without changing task ownership", () => {
    const moving = task("a", "backlog", {
      projectId: "10000000-0000-4000-8000-000000000002",
      projectName: "项目 B",
    });
    const plan = planTaskDrop([moving, task("b"), task("c")], {
      activeTaskId: "a",
      targetColumn: "todo",
      overTaskId: "b",
      position: "after",
    });

    expect(plan?.tasks.map(({ id }) => id)).toEqual(["b", "a", "c"]);
    expect(plan?.tasks.find(({ id }) => id === "a")).toMatchObject({
      projectId: "10000000-0000-4000-8000-000000000002",
      status: "todo",
    });
  });

  it("rejects non-adjacent columns and preserves blocked semantics in the same column", () => {
    const blocked = task("blocked", "blocked", { blockedFromStatus: "todo" });
    expect(
      planTaskDrop([task("a", "backlog"), task("b", "in_progress")], {
        activeTaskId: "a",
        targetColumn: "in_progress",
        overTaskId: "b",
        position: "before",
      }),
    ).toBeNull();

    const plan = planTaskDrop([task("a"), blocked, task("c")], {
      activeTaskId: "blocked",
      targetColumn: "todo",
      overTaskId: "a",
      position: "before",
    });
    expect(plan?.tasks.map(({ id }) => id)).toEqual(["blocked", "a", "c"]);
    expect(plan?.tasks[0]).toMatchObject({ status: "blocked", blockedFromStatus: "todo" });
  });

  it("derives upper and lower insertion halves from translated rectangles", () => {
    const over = { top: 100, height: 40 };
    expect(dropPositionFromRects({ top: 82, height: 40 }, over)).toBe("before");
    expect(dropPositionFromRects({ top: 102, height: 40 }, over)).toBe("after");
  });

  it("includes the current board scope in the move command", () => {
    const plan = planTaskDrop([task("a"), task("b")], {
      activeTaskId: "a",
      targetColumn: "todo",
      overTaskId: "b",
      position: "after",
    });
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(createTaskMoveCommand(plan, "00000000-0000-4000-8000-0000000000a1")).toEqual({
      expectedVersion: 3,
      targetStatus: "todo",
      boardProjectId: "00000000-0000-4000-8000-0000000000a1",
    });
  });
});
