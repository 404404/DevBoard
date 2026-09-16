import { ALL_PROJECT_ID, type BoardEvent } from "@codexboard/contracts";
import { describe, expect, it } from "vitest";

import {
  cursorInvalidationKeys,
  eventInvalidationKeys,
  fullRefreshQueryKeys,
  taskMutationInvalidationKeys,
  visibleRealtimeState,
} from "./event-feed";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const relatedTaskId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000001";

function event(eventType: string, safePayload: Record<string, unknown>): BoardEvent {
  return {
    revision: 1,
    aggregateType: "task",
    aggregateId: taskId,
    eventType,
    safePayload,
    createdAt: "2026-08-31T00:00:00.000Z",
  };
}

describe("event feed cache invalidation", () => {
  it("does not report a reconnecting stream before any project is selected", () => {
    expect(visibleRealtimeState(undefined, "connecting")).toBeUndefined();
    expect(visibleRealtimeState(projectId, "live")).toBe("live");
  });

  it("refreshes board, dashboard, task and workspace for task changes", () => {
    expect(eventInvalidationKeys(projectId, event("task.updated", { projectId }))).toEqual([
      ["board", projectId],
      ["dashboard", projectId],
      ["task", taskId],
      ["workspace", taskId],
      ["lifecycle", taskId],
    ]);
  });

  it("removes a failed task from another client's board and task caches", () => {
    expect(
      eventInvalidationKeys(projectId, event("task.creation_failed", { projectId, taskId })),
    ).toEqual([
      ["board", projectId],
      ["dashboard", projectId],
      ["task", taskId],
      ["workspace", taskId],
      ["lifecycle", taskId],
    ]);
  });

  it("refreshes execution summaries and both sides of workspace relations", () => {
    expect(
      eventInvalidationKeys(projectId, event("job.running", { projectId, taskId, jobId })),
    ).toEqual([
      ["board", projectId],
      ["dashboard", projectId],
      ["task", taskId],
      ["jobs", taskId],
      ["workspace", taskId],
      ["interactions", jobId],
    ]);
    expect(
      eventInvalidationKeys(
        projectId,
        event("relation.created", { projectId, taskId, relatedTaskId }),
      ),
    ).toEqual([
      ["board", projectId],
      ["dashboard", projectId],
      ["task", taskId],
      ["workspace", taskId],
      ["task", relatedTaskId],
      ["workspace", relatedTaskId],
    ]);
  });

  it("builds precise cache keys for a task mutation without clearing unrelated projects", () => {
    expect(taskMutationInvalidationKeys(projectId, [taskId, "", relatedTaskId, taskId])).toEqual([
      ["board", projectId],
      ["dashboard", projectId],
      ["task", taskId],
      ["workspace", taskId],
      ["task", relatedTaskId],
      ["workspace", relatedTaskId],
    ]);
  });

  it("refreshes other clients when a newly created task receives its draft Thread", () => {
    expect(
      eventInvalidationKeys(
        projectId,
        event("codex.thread_created", { projectId, taskId, status: "draft" }),
      ),
    ).toEqual([
      ["board", projectId],
      ["dashboard", projectId],
      ["task", taskId],
      ["jobs", taskId],
      ["workspace", taskId],
    ]);
  });

  it("refreshes the actor-specific dashboard after a task is marked read", () => {
    expect(eventInvalidationKeys(projectId, event("task.read", { projectId, taskId }))).toEqual([
      ["dashboard", projectId],
    ]);
  });

  it("refreshes project navigation and all project-derived task caches after Codex sync", () => {
    expect(eventInvalidationKeys(projectId, event("project.sync_updated", { projectId }))).toEqual([
      ["projects"],
      ["board"],
      ["dashboard"],
      ["task"],
      ["workspace"],
    ]);
  });

  it("refreshes the shared label catalog and project creation options after label changes", () => {
    expect(
      eventInvalidationKeys(projectId, event("label.updated", { projectId, labelId: taskId })),
    ).toEqual([
      ["labels"],
      ["task-creation-options"],
      ["board", projectId],
      ["task"],
      ["workspace"],
    ]);
  });

  it("invalidates every project-derived cache after a cursor gap", () => {
    expect(fullRefreshQueryKeys(projectId)).toEqual([
      ["projects"],
      ["labels"],
      ["task-creation-options"],
      ["board", projectId],
      ["dashboard", projectId],
      ["task"],
      ["workspace"],
      ["jobs"],
      ["interactions"],
    ]);
  });
});

it("附件删除会刷新活动与附件列表", () => {
  expect(eventInvalidationKeys(projectId, event("attachment.deleted", { taskId }))).toContainEqual([
    "workspace",
    taskId,
  ]);
});

it("全部项目的游标通知触发受鉴权重读，普通项目不因其他项目的游标更新刷新", () => {
  expect(cursorInvalidationKeys(ALL_PROJECT_ID)).toEqual(fullRefreshQueryKeys(ALL_PROJECT_ID));
  expect(cursorInvalidationKeys(projectId)).toEqual([]);
});

it("refreshes replies and project context options after conversation synchronization", () => {
  const projectId = "project";
  const taskId = "task";
  const base = {
    revision: 1,
    aggregateId: taskId,
    safePayload: { projectId, taskId },
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  expect(
    eventInvalidationKeys(projectId, {
      ...base,
      aggregateType: "task",
      eventType: "task.workspace_synced",
    }),
  ).toContainEqual(["task-creation-options", projectId]);
  expect(
    eventInvalidationKeys(projectId, {
      ...base,
      aggregateType: "job",
      eventType: "codex.history_synced",
    }),
  ).toContainEqual(["workspace", taskId]);
});
