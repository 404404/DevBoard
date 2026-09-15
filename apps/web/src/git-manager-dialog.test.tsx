import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { GitCreationOrigin, ProjectView } from "@codexboard/contracts";
import { GitManagerDialog } from "./git-manager-dialog";

function render(branchOrigin?: GitCreationOrigin, worktreeOrigin?: GitCreationOrigin) {
  const client = new QueryClient();
  client.setQueryData(["git-management", "project"], {
    mainPath: "/repo",
    currentBranch: "main",
    defaultBranch: "main",
    entries: [
      {
        branch: "feature/test",
        path: "/repo/.worktrees/test",
        headSha: "a".repeat(40),
        isMain: false,
        isCurrent: false,
        dirty: false,
        locked: false,
        taskCount: 0,
        deleteReason: null,
        branchOrigin,
        worktreeOrigin,
      },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GitManagerDialog
        projects={[
          {
            id: "project",
            name: "项目",
            kind: "codex",
            syncState: "synced",
            archivedAt: null,
          } as ProjectView,
        ]}
        csrfToken="csrf"
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}
it("links the creating Codex conversation and shows a separate worktree creator", () => {
  const html = render(
    { kind: "codex", threadId: "11111111-1111-4111-8111-111111111111", threadTitle: "修复删除" },
    { kind: "user", userKey: "user", userName: "严启鹏" },
  );
  expect(html).toContain('href="codex://threads/11111111-1111-4111-8111-111111111111"');
  expect(html).toContain("Codex 对话创建：修复删除");
  expect(html).toContain("严启鹏 创建");
});
it("distinguishes recorded Terminal creation from missing provenance", () => {
  const html = render({ kind: "terminal" });
  expect(html).toContain("Terminal 创建");
  expect(html).toContain("来源未知");
  expect(html).not.toContain("codex://");
});
