import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectTaskCreationOptionsViewSchema, ProjectViewSchema } from "@lark-codex/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskCreateDialog } from "./task-create-dialog";

const project = ProjectViewSchema.parse({
  id: "10000000-0000-4000-8000-000000000001",
  projectKey: "TEST",
  name: "测试项目",
  description: "",
  kind: "codex",
  membershipRole: "owner",
  version: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  archivedAt: null,
});

describe("task creation current identity display", () => {
  it("shows the current tenant's user when another tenant has the same user_id", () => {
    const client = new QueryClient();
    client.setQueryData(
      ["task-creation-options", project.id],
      ProjectTaskCreationOptionsViewSchema.parse({
        projectId: project.id,
        currentIdentity: { kind: "feishu", tenantKey: "tenant-b", userId: "same" },
        assignees: [
          {
            identity: { kind: "feishu", tenantKey: "tenant-a", userId: "same" },
            name: "其他企业用户",
            avatarUrl: null,
            actorRole: "member",
            projectRole: "viewer",
          },
          {
            identity: { kind: "feishu", tenantKey: "tenant-b", userId: "same" },
            name: "当前企业用户",
            avatarUrl: null,
            actorRole: "member",
            projectRole: "viewer",
          },
        ],
        labels: [],
        developmentContexts: [],
        defaultDevelopmentContext: { id: null, label: "无", branch: null },
        relationCandidates: [],
        attachmentMaxBytes: 1024,
      }),
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TaskCreateDialog
          project={project}
          projects={[project]}
          csrfToken={"x".repeat(32)}
          mutationsEnabled
          onClose={() => undefined}
          onCreated={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('aria-label="负责人：当前企业用户"');
    expect(html).not.toContain("其他企业用户");
    client.clear();
  });
});
