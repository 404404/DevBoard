import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectViewSchema, SessionViewSchema } from "@codexboard/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { BoardPage } from "./board";

afterEach(() => vi.unstubAllGlobals());

it("offers label and Git management to a signed-in user without project membership", () => {
  const project = ProjectViewSchema.parse({
    id: "10000000-0000-4000-8000-000000000001",
    projectKey: "TEST",
    name: "测试项目",
    description: "",
    kind: "codex",
    membershipRole: null,
    version: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    archivedAt: null,
  });
  const session = SessionViewSchema.parse({
    actor: {
      identity: { kind: "feishu", tenantKey: "test-tenant", userId: "test-user" },
      name: "飞书用户",
      avatarUrl: null,
      role: "member",
    },
    csrfToken: "x".repeat(32),
    expiresAt: "2026-09-13T00:00:00.000Z",
  });
  vi.stubGlobal("window", {
    location: { href: `https://tasks.example.test/?project=${project.id}` },
    localStorage: { getItem: () => null },
  });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  client.setQueryData(["projects"], [project]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BoardPage session={session} />
    </QueryClientProvider>,
  );
  expect(html).toContain("标签管理</span>");
  expect(html).toContain("分支 / worktree 管理</span>");
  client.clear();
});
