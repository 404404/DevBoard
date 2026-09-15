import type { TaskView } from "@codexboard/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { invalidateTaskDeletionQueries } from "./task-delete-cache";
import { TaskDeleteDialog } from "./task-delete-dialog";

const task = {
  id: "10000000-0000-4000-8000-000000000001",
  identifier: "TASK-001",
  title: "取消的任务",
  status: "canceled",
  version: 3,
} as TaskView;

describe("TaskDeleteDialog", () => {
  it("explains both Codex archival and irreversible local deletion", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TaskDeleteDialog
          task={task}
          csrfToken="csrf"
          onClose={() => undefined}
          onDeleted={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("彻底删除 TASK-001");
    expect(html).toContain("Codex 原始任务将先归档");
    expect(html).toContain("永久删除");
    expect(html).toContain("取消的任务");
  });

  it("invalidates both real-project and all-project board/dashboard caches", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["board", "real-project"], { tasks: [task] });
    queryClient.setQueryData(["board", "all-projects"], { tasks: [task] });
    queryClient.setQueryData(["dashboard", "real-project"], { totalTasks: 1 });
    queryClient.setQueryData(["dashboard", "all-projects"], { totalTasks: 1 });

    await invalidateTaskDeletionQueries(queryClient);

    for (const queryKey of [
      ["board", "real-project"],
      ["board", "all-projects"],
      ["dashboard", "real-project"],
      ["dashboard", "all-projects"],
    ]) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
  });
});
