import type { TaskView } from "@lark-taskboard/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskArchiveDrawer } from "./task-archive-drawer";

function task(status: "done" | "canceled", id: string, title: string): TaskView {
  return {
    id,
    identifier: `VIEW-${id.at(-1)}`,
    projectId: "10000000-0000-4000-8000-000000000001",
    projectName: "测试项目",
    originProjectName: null,
    codexThreadState: "none",
    permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
    taskNumber: 1,
    title,
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
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
  };
}

describe("TaskArchiveDrawer", () => {
  const done = task("done", "30000000-0000-4000-8000-000000000001", "已交付任务");
  const canceled = task("canceled", "30000000-0000-4000-8000-000000000002", "停止任务");

  it("offers physical deletion for completed tasks with write permission", () => {
    const html = renderToStaticMarkup(
      createElement(TaskArchiveDrawer, {
        tasks: [done, canceled],
        open: true,
        onOpenTask: () => undefined,
        onDeleteTask: () => undefined,
      }),
    );

    expect(html).toContain("status-column--archive");
    expect(html).toContain('aria-label="其他任务"');
    expect(html).toContain('class="status-header other-tasks-header"');
    expect(html).toContain("其他任务");
    expect(html).toContain('class="archive-tabs"');
    expect(html.indexOf("other-tasks-header")).toBeLessThan(html.indexOf("archive-tabs"));
    expect(html).toContain("task-card archive-task-card");
    expect(html).toContain("task-open archive-task-open");
    expect(html).toContain("task-card-actions archive-task-actions");
    expect(html).not.toContain("archive-drawer__header");
    expect(html).toContain("已完成 1");
    expect(html).toContain("已取消 1");
    expect(html).toContain("已交付任务");
    expect(html).toContain('aria-label="彻底删除任务 VIEW-1"');
  });

  it("also offers physical deletion from the canceled tab", () => {
    const html = renderToStaticMarkup(
      createElement(TaskArchiveDrawer, {
        tasks: [done, canceled],
        open: true,
        initialTab: "canceled",
        onOpenTask: () => undefined,
        onDeleteTask: () => undefined,
      }),
    );

    expect(html).toContain("停止任务");
    expect(html).toContain('aria-label="彻底删除任务 VIEW-2"');
    expect(html).not.toContain("已交付任务");
  });

  it("leaves opening and closing exclusively to the external archive trigger", () => {
    const html = renderToStaticMarkup(
      createElement(TaskArchiveDrawer, {
        tasks: [done, canceled],
        open: true,
        onOpenTask: () => undefined,
        onDeleteTask: () => undefined,
      }),
    );

    expect(html).not.toContain("archive-drawer-backdrop");
    expect(html).not.toContain("关闭其他任务");
  });

  it.each(["done", "canceled"] as const)("hides deletion for read-only %s tasks", (status) => {
    const readOnly = task(status, "30000000-0000-4000-8000-000000000003", "只读任务");
    const html = renderToStaticMarkup(
      createElement(TaskArchiveDrawer, {
        tasks: [{ ...readOnly, permissions: { ...readOnly.permissions, canWrite: false } }],
        open: true,
        initialTab: status,
        onOpenTask: () => undefined,
        onDeleteTask: () => undefined,
      }),
    );
    expect(html).not.toContain("彻底删除任务");
  });
});
