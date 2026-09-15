import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskView } from "@codexboard/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TaskCardPresentation } from "./task-card";
const person = {
  identity: { kind: "feishu" as const, tenantKey: "preview", userId: "preview" },
  name: "张晓明 · 产品研发负责人",
  avatarUrl: null,
};
const base = {
  id: "a",
  projectId: "preview",
  projectName: "任务卡片验收",
  originProjectName: null,
  codexThreadState: "started",
  permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
  taskNumber: 1,
  identifier: "DEMO-1",
  title: "完善移动端任务体验",
  description: "优化任务卡片显示，保持信息简洁、清晰。",
  status: "in_progress",
  blockedFromStatus: null,
  priority: "medium",
  labels: [],
  assigneeIdentity: person.identity,
  assignee: person,
  creatorIdentity: null,
  startAt: null,
  dueAt: null,
  recurrence: null,
  developmentContextId: null,
  links: [],
  sortOrder: 1,
  version: 1,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  archivedAt: null,
} satisfies TaskView;

function render(task: TaskView, progress: { completed: number; total: number } | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  client.setQueryData(["task-progress", task.id], progress);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TaskCardPresentation task={task} projectKind="codex" />
    </QueryClientProvider>,
  );
}
it("shows an avatar with the full Feishu name as a tooltip, without a text label", () => {
  const html = render(base);
  expect(html).toContain(`title="${person.name}"`);
  expect(html).not.toContain(`>${person.name}<`);
  expect(html).not.toContain("未分配负责人");
  expect(render({ ...base, assignee: null, assigneeIdentity: null })).not.toContain(
    "task-card-assignee",
  );
  expect(
    render({ ...base, assigneeIdentity: { kind: "service", serviceId: "codex" } }),
  ).not.toContain("task-card-assignee");
});
it("shows actual steps only on processing cards with available progress", () => {
  const html = render(base, { completed: 2, total: 5 });
  expect(html).toContain('aria-valuenow="2"');
  expect(html).toContain('aria-valuemax="5"');
  expect(html.match(/class="is-complete"/g)).toHaveLength(2);
  expect(render(base)).not.toContain('role="progressbar"');
  expect(render({ ...base, status: "todo" }, { completed: 2, total: 5 })).not.toContain(
    'role="progressbar"',
  );
  expect(render(base, { completed: 0, total: 3 })).toContain('aria-valuenow="0"');
});
