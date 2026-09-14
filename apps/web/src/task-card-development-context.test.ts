import { describe, expect, it } from "vitest";
import { taskCardDevelopmentContext } from "./task-card-development-context";
const defaultDevelopmentContext = { id: null, label: "main", branch: "main" };
const context = {
  id: "worktree",
  kind: "worktree" as const,
  label: "未绑定分支",
  branch: "feature/sync",
  gitRef: null,
  headSha: null,
  worktreeRealpath: "/workspace/.worktrees/sync",
  executable: true,
  active: true,
  scannedAt: "2026-09-09T00:00:00Z",
};
describe("卡片分支", () => {
  it("显示选中工作树的实际分支", () => {
    expect(
      taskCardDevelopmentContext(
        { developmentContextId: "worktree" },
        { defaultDevelopmentContext, developmentContexts: [context] },
      ),
    ).toEqual({
      branch: "feature/sync",
      label: "未绑定分支",
    });
  });
  it("未选择时显示默认分支", () => {
    expect(
      taskCardDevelopmentContext(
        { developmentContextId: null },
        { defaultDevelopmentContext, developmentContexts: [] },
      ),
    ).toEqual({ branch: "main", label: "未绑定分支" });
  });
  it("失效绑定不会误显示默认分支", () => {
    expect(
      taskCardDevelopmentContext(
        { developmentContextId: "deleted" },
        { defaultDevelopmentContext, developmentContexts: [] },
      ),
    ).toEqual({ branch: null, label: "分支不可用" });
  });
});
