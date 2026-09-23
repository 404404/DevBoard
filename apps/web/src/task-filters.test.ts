import type { TaskView } from "@codexboard/contracts";
import { describe, expect, it } from "vitest";

import { availableFilterOptions, filterTasks, type TaskFilters } from "./task-filters";

function task(
  overrides: Partial<TaskView> & Pick<TaskView, "id" | "identifier" | "title">,
): TaskView {
  const { id, identifier, title, ...rest } = overrides;
  return {
    id,
    identifier,
    projectId: "10000000-0000-4000-8000-000000000001",
    projectName: "测试项目",
    originProjectName: null,
    codexThreadState: "none",
    permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
    taskNumber: 1,
    title,
    description: "",
    status: "todo",
    blockedFromStatus: null,
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
    ...rest,
  };
}

const EMPTY: TaskFilters = {
  query: "",
  statuses: new Set(),
  priorities: new Set(),
  labels: new Set(),
};

describe("task filters", () => {
  const tasks = [
    task({
      id: "30000000-0000-4000-8000-000000000001",
      identifier: "VIEW-1",
      title: "附件权限审查",
      description: "验证下载",
      status: "in_review",
      priority: "urgent",
      labels: ["安全", "后端"],
    }),
    task({
      id: "30000000-0000-4000-8000-000000000002",
      identifier: "VIEW-2",
      title: "列表视图",
      status: "todo",
      priority: "low",
      labels: ["前端"],
    }),
  ];

  it.each(["view-1", "附件权限", "验证下载", "安全"])(
    "searches identifier, title, description and labels with %s",
    (query) => {
      expect(filterTasks(tasks, { ...EMPTY, query }).map((value) => value.identifier)).toEqual([
        "VIEW-1",
      ]);
    },
  );

  it("combines values within one category with OR and categories with AND", () => {
    expect(
      filterTasks(tasks, {
        query: "",
        statuses: new Set(["todo", "in_review"]),
        priorities: new Set(["urgent"]),
        labels: new Set(["安全", "不存在"]),
      }).map((value) => value.identifier),
    ).toEqual(["VIEW-1"]);
  });

  it("returns a fresh array without mutating the source when no filters are selected", () => {
    const result = filterTasks(tasks, EMPTY);
    expect(result).toEqual(tasks);
    expect(result).not.toBe(tasks);
    expect(tasks.map((value) => value.identifier)).toEqual(["VIEW-1", "VIEW-2"]);
  });

  it("computes availability from every project task instead of the filtered result", () => {
    const filtered = filterTasks(tasks, { ...EMPTY, query: "VIEW-1" });
    const available = availableFilterOptions(tasks);

    expect(filtered.map((value) => value.identifier)).toEqual(["VIEW-1"]);
    expect(available.statuses).toEqual(new Set(["in_review", "todo"]));
    expect(available.priorities).toEqual(new Set(["urgent", "low"]));
    expect(available.labels).toEqual(new Set(["安全", "后端", "前端"]));
    expect(available.statuses.has("done")).toBe(false);
  });
});
