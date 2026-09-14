import {
  ALL_PROJECT_ID,
  TEMPORARY_PROJECT_ID,
  type ProjectView,
  type SessionView,
  type TaskView,
} from "@lark-codex/contracts";
import { describe, expect, it } from "vitest";

import {
  canCreateTaskInProject,
  creatableTaskProjects,
  defaultTaskCreationProjectId,
  orderProjectViews,
  reassignableProjects,
  taskProjectContext,
  visibleProjectKey,
} from "./project-sync";

function project(
  overrides: Partial<ProjectView> & Pick<ProjectView, "id" | "name" | "kind">,
): ProjectView {
  const { id, name, kind, ...rest } = overrides;
  return {
    id,
    projectKey: kind === "all" ? null : kind === "temporary" ? "TEMP" : "CODEX",
    name,
    description: "",
    kind,
    rootPaths: [],
    syncState: "synced",
    membershipRole: "owner",
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    ...rest,
  } as ProjectView;
}

const session = {
  actor: { role: "member" },
} as SessionView;

describe("Codex 项目同步界面规则", () => {
  it("全部项目不显示 Key，临时项目和 Codex 项目显示各自 Key", () => {
    expect(
      visibleProjectKey(project({ id: ALL_PROJECT_ID, name: "全部项目", kind: "all" })),
    ).toBeNull();
    expect(
      visibleProjectKey(project({ id: TEMPORARY_PROJECT_ID, name: "临时项目", kind: "temporary" })),
    ).toBe("TEMP");
    expect(
      visibleProjectKey(
        project({
          id: "10000000-0000-4000-8000-000000000001",
          name: "Codex",
          kind: "codex",
        }),
      ),
    ).toBe("CODEX");
  });

  it("固定把全部项目、临时项目排在 Codex 项目前面", () => {
    const codex = project({
      id: "10000000-0000-4000-8000-000000000001",
      name: "Lark-Codex",
      kind: "codex",
    });
    const temporary = project({ id: TEMPORARY_PROJECT_ID, name: "临时项目", kind: "temporary" });
    const all = project({ id: ALL_PROJECT_ID, name: "全部项目", kind: "all" });

    expect(orderProjectViews([codex, temporary, all]).map((value) => value.id)).toEqual([
      ALL_PROJECT_ID,
      TEMPORARY_PROJECT_ID,
      codex.id,
    ]);
  });

  it("已登录用户无需成员权限即可在有效项目创建任务", () => {
    const all = project({ id: ALL_PROJECT_ID, name: "全部项目", kind: "all" });
    const temporary = project({
      id: TEMPORARY_PROJECT_ID,
      name: "临时项目",
      kind: "temporary",
    });
    const editable = project({
      id: "10000000-0000-4000-8000-000000000001",
      name: "可编辑 Codex 项目",
      kind: "codex",
      membershipRole: "editor",
    });
    const readOnly = project({
      id: "10000000-0000-4000-8000-000000000002",
      name: "只读 Codex 项目",
      kind: "codex",
      membershipRole: "viewer",
    });

    const projects = [all, temporary, editable, readOnly];
    expect(projects.map((value) => canCreateTaskInProject(session, value, projects))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(creatableTaskProjects(session, projects).map((value) => value.id)).toEqual([
      TEMPORARY_PROJECT_ID,
      editable.id,
      readOnly.id,
    ]);
    const archived = { ...readOnly, archivedAt: "2026-09-12T00:00:00.000Z" };
    const unregistered = { ...readOnly, membershipRole: null };
    expect(canCreateTaskInProject(session, unregistered)).toBe(true);
    expect(canCreateTaskInProject(session, archived)).toBe(false);
    expect(creatableTaskProjects(session, [archived])).toEqual([]);
  });

  it("全部项目默认创建到临时项目，其他看板固定创建到当前项目", () => {
    expect(
      defaultTaskCreationProjectId(project({ id: ALL_PROJECT_ID, name: "全部项目", kind: "all" })),
    ).toBe(TEMPORARY_PROJECT_ID);
    expect(
      defaultTaskCreationProjectId(
        project({ id: TEMPORARY_PROJECT_ID, name: "临时项目", kind: "temporary" }),
      ),
    ).toBe(TEMPORARY_PROJECT_ID);
    const codexId = "10000000-0000-4000-8000-000000000001";
    expect(
      defaultTaskCreationProjectId(
        project({
          id: codexId,
          name: "Codex",
          kind: "codex",
        }),
      ),
    ).toBe(codexId);
  });

  it("全部项目显示当前项目，临时项目显示原项目", () => {
    const task = {
      projectName: "临时项目",
      originProjectName: "已删除的 Codex 项目",
    } as TaskView;
    expect(taskProjectContext(task, "all")).toBe("临时项目");
    expect(taskProjectContext(task, "temporary")).toBe("原项目：已删除的 Codex 项目");
    expect(taskProjectContext(task, "codex")).toBeNull();
  });

  it("重新分配目标只包含 Codex 项目，并在同步离线时保留上次快照", () => {
    const codex = project({
      id: "10000000-0000-4000-8000-000000000001",
      name: "Codex",
      kind: "codex",
    });
    const stale = project({
      id: "10000000-0000-4000-8000-000000000002",
      name: "离线快照项目",
      kind: "codex",
      syncState: "stale",
    });
    expect(
      reassignableProjects([
        project({ id: ALL_PROJECT_ID, name: "全部项目", kind: "all" }),
        project({ id: TEMPORARY_PROJECT_ID, name: "临时项目", kind: "temporary" }),
        codex,
        stale,
      ]).map((value) => value.id),
    ).toEqual([codex.id, stale.id]);
  });
});
