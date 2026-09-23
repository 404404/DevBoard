import type { TaskView } from "@codexboard/contracts";
import { describe, expect, it } from "vitest";

import {
  canSelectTaskStatus,
  ACTIVE_BOARD_STATUSES,
  ARCHIVE_STATUSES,
  canDropTaskBetweenStatuses,
  displayColumnForTask,
  FILTERABLE_TASK_STATUSES,
  groupTasksForWorkspace,
  targetStatusForTaskDrop,
  TASK_STATUS_META,
  TASK_STATUS_ORDER,
} from "./task-status";

function blockedTask(blockedFromStatus: TaskView["blockedFromStatus"]): TaskView {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    identifier: "VIEW-1",
    projectId: "10000000-0000-4000-8000-000000000001",
    projectName: "测试项目",
    originProjectName: null,
    codexThreadState: "none",
    permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
    taskNumber: 1,
    title: "阻塞任务",
    description: "",
    status: "blocked",
    blockedFromStatus,
    priority: "none",
    labels: [],
    assigneeIdentity: null,
    creatorIdentity: null,
    startAt: null,
    dueAt: null,
    recurrence: null,
    milestoneId: null,
    developmentContextId: null,
    links: [],
    sortOrder: 1,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
  };
}

describe("task status presentation", () => {
  it("keeps every workflow status available for filtering", () => {
    expect(TASK_STATUS_META.in_review.symbol).toBe("eye");
    expect(FILTERABLE_TASK_STATUSES).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "blocked",
      "done",
      "canceled",
    ]);
  });

  it("keeps the seven approved statuses and their Chinese labels in workflow order", () => {
    expect(TASK_STATUS_ORDER).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "blocked",
      "done",
      "canceled",
    ]);
    expect(TASK_STATUS_ORDER.map((status) => TASK_STATUS_META[status].label)).toEqual([
      "待立项",
      "待处理",
      "处理中",
      "待验收",
      "已阻塞",
      "已完成",
      "已取消",
    ]);
    expect(TASK_STATUS_ORDER.every((status) => TASK_STATUS_META[status].symbol.length > 0)).toBe(
      true,
    );
    expect(TASK_STATUS_ORDER.map((status) => TASK_STATUS_META[status].symbol)).toEqual([
      "lightbulb",
      "circle",
      "circle.lefthalf.filled",
      "eye",
      "exclamationmark.octagon.fill",
      "checkmark.circle.fill",
      "xmark.circle.fill",
    ]);
    expect(new Set(TASK_STATUS_ORDER.map((status) => TASK_STATUS_META[status].symbol)).size).toBe(
      7,
    );
  });

  it("only permits reordering in place or moving to an adjacent active status", () => {
    expect(canDropTaskBetweenStatuses("backlog", "backlog")).toBe(true);
    expect(canDropTaskBetweenStatuses("backlog", "todo")).toBe(true);
    expect(canDropTaskBetweenStatuses("todo", "backlog")).toBe(true);
    expect(canDropTaskBetweenStatuses("todo", "in_progress")).toBe(true);
    expect(canDropTaskBetweenStatuses("in_progress", "todo")).toBe(true);
    expect(canDropTaskBetweenStatuses("in_progress", "in_review")).toBe(true);
    expect(canDropTaskBetweenStatuses("in_review", "in_progress")).toBe(true);
    expect(canDropTaskBetweenStatuses("backlog", "in_progress")).toBe(false);
    expect(canDropTaskBetweenStatuses("backlog", "in_review")).toBe(false);
    expect(canDropTaskBetweenStatuses("todo", "in_review")).toBe(false);
    expect(canDropTaskBetweenStatuses("in_review", "todo")).toBe(false);
  });

  it("shows four active columns, archives terminal statuses and restores blocked placement", () => {
    expect(ACTIVE_BOARD_STATUSES).toEqual(["backlog", "todo", "in_progress", "in_review"]);
    expect(ARCHIVE_STATUSES).toEqual(["done", "canceled"]);
    expect(displayColumnForTask(blockedTask("todo"))).toBe("todo");
  });

  it("keeps a blocked task blocked when sorting inside its displayed column", () => {
    expect(targetStatusForTaskDrop(blockedTask("todo"), "todo")).toBe("blocked");
  });

  it("unblocks a blocked task only when dropping it into an adjacent active column", () => {
    expect(targetStatusForTaskDrop(blockedTask("todo"), "in_progress")).toBe("in_progress");
  });

  it("groups blocked tasks into their origin column and terminal tasks into the drawer", () => {
    const blocked = blockedTask("todo");
    const backlog = {
      ...blocked,
      id: "30000000-0000-4000-8000-000000000002",
      status: "backlog",
      blockedFromStatus: null,
    } as TaskView;
    const done = {
      ...blocked,
      id: "30000000-0000-4000-8000-000000000003",
      status: "done",
      blockedFromStatus: null,
    } as TaskView;
    const canceled = {
      ...blocked,
      id: "30000000-0000-4000-8000-000000000004",
      status: "canceled",
      blockedFromStatus: null,
    } as TaskView;

    const grouped = groupTasksForWorkspace([backlog, blocked, done, canceled]);

    expect(grouped.active.backlog).toEqual([backlog]);
    expect(grouped.active.todo).toEqual([blocked]);
    expect(grouped.active.in_progress).toEqual([]);
    expect(grouped.active.in_review).toEqual([]);
    expect(grouped.archive.done).toEqual([done]);
    expect(grouped.archive.canceled).toEqual([canceled]);
  });
});

it("详情状态只允许相邻活动列，阻塞任务按原列计算", () => {
  const task = { ...blockedTask("todo"), status: "todo" as const, blockedFromStatus: null };
  expect(canSelectTaskStatus(task, "backlog")).toBe(true);
  expect(canSelectTaskStatus(task, "in_progress")).toBe(true);
  expect(canSelectTaskStatus(task, "in_review")).toBe(false);
  expect(canSelectTaskStatus(task, "done")).toBe(false);
  expect(canSelectTaskStatus(task, "canceled")).toBe(false);
  expect(canSelectTaskStatus(blockedTask("todo"), "todo")).toBe(true);
  expect(canSelectTaskStatus(blockedTask("todo"), "in_review")).toBe(false);
});
