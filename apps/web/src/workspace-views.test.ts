import { ALL_PROJECT_ID, type DashboardView, type TaskView } from "@codexboard/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DashboardPanel, EMPTY_FILTERS, filterTasks, WorkspaceTabs } from "./workspace-views";

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
    permissions: {
      canRead: true,
      canWrite: true,
      canExecute: true,
      canReassign: false,
    },
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
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    archivedAt: null,
    ...rest,
  };
}

describe("filterTasks", () => {
  it("combines search, status, priority and label filters", () => {
    const tasks = [
      task({
        id: "30000000-0000-4000-8000-000000000001",
        identifier: "VIEW-1",
        title: "附件权限审查",
        description: "验证下载",
        status: "in_review",
        priority: "urgent",
        labels: ["安全"],
        dueAt: "2026-09-02T00:00:00.000Z",
      }),
      task({
        id: "30000000-0000-4000-8000-000000000002",
        identifier: "VIEW-2",
        title: "列表视图",
        status: "todo",
        priority: "low",
        labels: ["前端"],
        dueAt: "2026-10-01T00:00:00.000Z",
      }),
    ];

    expect(
      filterTasks(tasks, {
        query: "下载",
        statuses: new Set(["in_review"]),
        priorities: new Set(["urgent"]),
        labels: new Set(["安全"]),
      }).map((value) => value.identifier),
    ).toEqual(["VIEW-1"]);
  });

  it("does not mutate the source when filters are empty", () => {
    const tasks = [
      task({
        id: "30000000-0000-4000-8000-000000000003",
        identifier: "VIEW-3",
        title: "逾期任务",
        dueAt: "2026-08-30T00:00:00.000Z",
      }),
    ];
    const result = filterTasks(tasks, {
      query: "",
      statuses: new Set(),
      priorities: new Set(),
      labels: new Set(),
    });
    expect(result).toEqual(tasks);
    expect(result).not.toBe(tasks);
  });

  it("keeps large-list filtering within an interactive budget", () => {
    const tasks = Array.from({ length: 10_000 }, (_, index) =>
      task({
        id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        identifier: `VIEW-${index + 1}`,
        title: index === 9_999 ? "唯一命中任务" : `常规任务 ${index + 1}`,
      }),
    );
    const startedAt = performance.now();
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, query: "唯一命中" })).toHaveLength(1);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});

describe("WorkspaceTabs", () => {
  it("renders only dashboard, board and list after Gantt is removed", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceTabs, {
        value: "board",
        onChange: () => undefined,
      }),
    );
    for (const label of ["仪表盘", "看板", "列表"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("项目文档");
    expect(html).not.toContain("甘特图");
    expect(html).not.toContain("sf-symbol");
    expect(html.match(/role="tab"/g) ?? []).toHaveLength(3);
  });
});

describe("DashboardPanel", () => {
  it("renders the complete literal priority distribution", () => {
    const dashboard: DashboardView = {
      projectId: "10000000-0000-4000-8000-000000000001",
      totalTasks: 15,
      completedTasks: 5,
      completionPercent: 33,
      priorityCounts: { none: 1, urgent: 2, high: 3, medium: 4, low: 5 },
      blockedOrUnreadCount: 0,
      runningConversationCount: 0,
      blockedOrUnreadTasks: [],
      dueSoonTasks: [],
    };
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(DashboardPanel, {
          dashboard,
          onOpen: () => undefined,
          projectId: ALL_PROJECT_ID,
          csrfToken: "test-csrf-token",
          mutationsEnabled: false,
        }),
      ),
    );
    for (const expected of [
      "优先级分布",
      "无优先级</span><strong>1",
      "紧急</span><strong>2",
      "高</span><strong>3",
      "中</span><strong>4",
      "低</span><strong>5",
    ]) {
      expect(html).toContain(expected);
    }
  });
});
