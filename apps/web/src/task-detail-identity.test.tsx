import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrincipalView, TaskView } from "@codexboard/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TaskDetail } from "./task-detail";

const owner = {
  identity: { kind: "feishu" as const, tenantKey: "tenant-a", userId: "owner" },
  name: "任务实际负责人",
  avatarUrl: null,
};
const viewer: PrincipalView = {
  identity: { kind: "feishu", tenantKey: "tenant-a", userId: "viewer" },
  name: "当前查看人",
  avatarUrl: null,
  role: "member",
};
const task: TaskView = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000002",
  projectName: "测试项目",
  originProjectName: null,
  codexThreadState: "none",
  permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
  taskNumber: 1,
  identifier: "TEST-1",
  title: "保留真实任务负责人",
  description: "",
  status: "todo",
  blockedFromStatus: null,
  priority: "medium",
  labels: [],
  assigneeIdentity: owner.identity,
  assignee: owner,
  creatorIdentity: owner.identity,
  startAt: null,
  dueAt: null,
  recurrence: null,
  developmentContextId: null,
  links: [],
  sortOrder: 1,
  version: 1,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  archivedAt: null,
};

function render(value: TaskView) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  client.setQueryData(["task", value.id], value);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TaskDetail
        taskId={value.id}
        projectKind="codex"
        csrfToken={"x".repeat(32)}
        mutationsEnabled
        tasks={[value]}
        actor={viewer}
        onClose={() => undefined}
        onOpenTask={() => undefined}
        renderActions={() => null}
        renderReassign={() => null}
      />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

it("shows the actual task owner without offering an assignee picker to another viewer", () => {
  const html = render(task);
  expect(html).toContain("任务实际负责人");
  expect(html).not.toMatch(/<button[^>]*aria-label="负责人/);
  expect(html).not.toContain("未分配负责人");
  expect(html).not.toContain("负责人：当前查看人");
});

it("does not invent a current user owner when a historical task has no assignee", () => {
  const html = render({ ...task, assigneeIdentity: null, assignee: null });
  expect(html).toContain("负责人信息暂不可用");
  expect(html).not.toContain("未分配负责人");
  expect(html).not.toContain("负责人：当前查看人");
});
