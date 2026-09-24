import { describe, expect, it } from "vitest";
import type { TaskView } from "@codexboard/contracts";
import { TaskAutosave } from "./task-autosave";

const task: TaskView = {
  id: "task",
  identifier: "TEST-001",
  taskNumber: 1,
  projectId: "project",
  projectName: "项目",
  originProjectName: null,
  codexThreadState: "none",
  title: "原始标题",
  description: "原始描述",
  status: "todo",
  blockedFromStatus: null,
  priority: "none",
  labels: [],
  links: [],
  assigneeIdentity: null,
  creatorIdentity: null,
  startAt: null,
  dueAt: null,
  recurrence: null,
  milestoneId: null,
  developmentContextId: null,
  sortOrder: 1,
  version: 1,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  archivedAt: null,
  permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
};

describe("task autosave", () => {
  it("does not retry a failed value that the user has reverted", async () => {
    let fail = true;
    const save = new TaskAutosave(task, async (current, patch) => {
      if (fail) throw new Error("网络错误");
      return { ...current, ...patch, version: current.version + 1 };
    });
    save.edit({ title: "已经撤回的标题" });
    save.commit("title");
    await save.flush();
    save.edit({ title: "原始标题" });
    save.commit("title");
    fail = false;
    await save.retry();
    expect(save.getSnapshot().task.title).toBe("原始标题");
    expect(save.getSnapshot().task.version).toBe(1);
    expect(save.getSnapshot().dirty).toBe(false);
  });
  it("serializes field changes with the returned version and preserves newer typing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const versions: number[] = [];
    const save = new TaskAutosave(task, async (current, patch) => {
      versions.push(current.version);
      if (versions.length === 1) await gate;
      return { ...current, ...patch, version: current.version + 1 };
    });
    save.edit({ title: "第一次标题" });
    save.commit("title");
    save.edit({ title: "仍在输入" });
    save.edit({ priority: "high" });
    save.commit("priority");
    expect(versions).toEqual([1]);
    release();
    await save.flush();
    expect(versions).toEqual([1, 2]);
    expect(save.getSnapshot().task.title).toBe("第一次标题");
    expect(save.getSnapshot().draft.title).toBe("仍在输入");
    expect(save.getSnapshot().task.priority).toBe("high");
    save.commit("title");
    await save.flush();
    expect(save.getSnapshot().task.title).toBe("仍在输入");
    expect(save.getSnapshot().dirty).toBe(false);
  });

  it("stops on failure, keeps all drafts, and retries in order", async () => {
    let fail = true;
    const save = new TaskAutosave(task, async (current, patch) => {
      if (fail) throw new Error("网络错误");
      return { ...current, ...patch, version: current.version + 1 };
    });
    save.edit({ title: "保留草稿", status: "in_progress" });
    save.commit("title");
    save.commit("status");
    await save.flush();
    expect(save.getSnapshot().task.version).toBe(1);
    expect(save.getSnapshot().error).toBeInstanceOf(Error);
    expect(save.getSnapshot().draft.title).toBe("保留草稿");
    fail = false;
    await save.retry();
    expect(save.getSnapshot().task.title).toBe("保留草稿");
    expect(save.getSnapshot().task.status).toBe("in_progress");
    expect(save.getSnapshot().task.version).toBe(3);
    expect(save.getSnapshot().dirty).toBe(false);
  });

  it("does not replace unsaved drafts or silently bypass remote version conflicts", () => {
    const save = new TaskAutosave(task, async (current) => current);
    save.edit({ description: "我的草稿" });
    save.receive({ ...task, description: "他人编辑", version: 2 });
    expect(save.getSnapshot().draft.description).toBe("我的草稿");
    expect(save.getSnapshot().task.version).toBe(1);
    save.reset({ ...task, description: "他人编辑", version: 2 });
    expect(save.getSnapshot().draft.description).toBe("他人编辑");
    expect(save.getSnapshot().dirty).toBe(false);
  });

  it("rejects an empty title and does not send unchanged values", async () => {
    let requests = 0;
    const save = new TaskAutosave(task, async (current, patch) => {
      requests++;
      return { ...current, ...patch, version: current.version + 1 };
    });
    save.commit("title");
    await save.flush();
    expect(requests).toBe(0);
    save.edit({ title: "   " });
    save.commit("title");
    await save.flush();
    expect(save.getSnapshot().error).toBeInstanceOf(Error);
    expect(requests).toBe(0);
    save.edit({ title: "修正后的标题" });
    save.commit("title");
    await save.flush();
    expect(save.getSnapshot().error).toBeUndefined();
    expect(save.getSnapshot().task.title).toBe("修正后的标题");
  });

  it("does not start queued requests after editing becomes disabled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = new TaskAutosave(task, async (current, patch) => {
      await gate;
      return { ...current, ...patch, version: current.version + 1 };
    });
    save.edit({ title: "新标题", priority: "high" });
    save.commit("title");
    save.commit("priority");
    save.setEnabled(false);
    release();
    await save.flush();
    expect(save.getSnapshot().task.priority).toBe("none");
    expect(save.getSnapshot().draft.priority).toBe("high");
  });
});

it("automatically saves a branch selection and retains it when reloaded", async () => {
  const save = new TaskAutosave(task, async (current, patch) => ({
    ...current,
    ...patch,
    version: current.version + 1,
  }));
  save.edit({ developmentContextId: "10000000-0000-4000-8000-000000000001" });
  save.commit("developmentContextId");
  await save.flush();
  const reloaded = new TaskAutosave(save.getSnapshot().task, async (current) => current);
  expect(reloaded.getSnapshot().draft.developmentContextId).toBe(
    "10000000-0000-4000-8000-000000000001",
  );
  expect(reloaded.getSnapshot().dirty).toBe(false);
});

it("keeps natural identities in drafts and persists a tenant change", async () => {
  const original = { kind: "feishu", tenantKey: "a", userId: "same" } as const;
  const changed = { ...original, tenantKey: "b" };
  const patches: unknown[] = [];
  const save = new TaskAutosave({ ...task, assigneeIdentity: original }, async (current, patch) => {
    patches.push(patch);
    return { ...current, ...patch, version: current.version + 1 };
  });
  expect(save.getSnapshot().draft.assigneeIdentity).toEqual(original);
  save.edit({ assigneeIdentity: changed });
  save.commit("assigneeIdentity");
  await save.flush();
  expect(patches).toEqual([
    { assigneeIdentity: { kind: "feishu", tenantKey: "b", userId: "same" } },
  ]);
  expect(save.getSnapshot().dirty).toBe(false);
});

it("does not mark a reordered representation of the same natural identity dirty", () => {
  const save = new TaskAutosave(
    { ...task, assigneeIdentity: { kind: "feishu", tenantKey: "a", userId: "same" } },
    async (current) => current,
  );
  save.edit({ assigneeIdentity: { userId: "same", kind: "feishu", tenantKey: "a" } });
  expect(save.getSnapshot().dirty).toBe(false);
});

it("preserves a historical service assignee while saving unrelated edits", async () => {
  const patches: unknown[] = [];
  const save = new TaskAutosave(
    { ...task, assigneeIdentity: { kind: "service", serviceId: "local-admin" } },
    async (current, patch) => {
      patches.push(patch);
      return { ...current, ...patch, version: current.version + 1 };
    },
  );
  save.edit({ title: "Edited historical task" });
  save.commit("title");
  await save.flush();
  expect(patches).toEqual([{ title: "Edited historical task" }]);
  expect(save.getSnapshot().task.assigneeIdentity).toEqual({
    kind: "service",
    serviceId: "local-admin",
  });
  expect(save.getSnapshot().error).toBeUndefined();
});

it("refuses a service identity as a new assignee even if an invalid UI patch reaches autosave", async () => {
  const patches: unknown[] = [];
  const save = new TaskAutosave(task, async (current, patch) => {
    patches.push(patch);
    return { ...current, ...patch };
  });
  save.edit({ assigneeIdentity: { kind: "service", serviceId: "codex" } } as never);
  save.commit("assigneeIdentity");
  await save.flush();
  expect(patches).toEqual([]);
  expect(save.getSnapshot().task.assigneeIdentity).toBeNull();
  expect(save.getSnapshot().error).toBeInstanceOf(Error);
});
