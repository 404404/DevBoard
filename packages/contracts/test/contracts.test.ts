import { describe, expect, it } from "vitest";

import {
  PrincipalSummarySchema,
  AttachmentViewSchema,
  BoardEventSchema,
  CreateGlobalLabelCommandSchema,
  CreateProjectCommandSchema,
  CreateTaskCommandSchema,
  DeleteTaskCommandSchema,
  EventFeedQuerySchema,
  EventPageSchema,
  EventStreamMessageSchema,
  ExpectedVersionSchema,
  IdempotencyKeySchema,
  PaginationQuerySchema,
  ProjectKindSchema,
  ProjectTaskCreationOptionsViewSchema,
  ProjectViewSchema,
  ReassignTaskCommandSchema,
  RuntimeDescriptorSchema,
  MoveTaskCommandSchema,
  CreateCommentCommandSchema,
  CreateTaskRelationCommandSchema,
  LocalOperationsSnapshotSchema,
  TaskWorkspaceViewSchema,
  TaskViewSchema,
  TaskLinkSchema,
  GlobalLabelListViewSchema,
  ReorderGlobalLabelsCommandSchema,
  UpdateGlobalLabelCommandSchema,
} from "../src/index.js";

describe("shared contracts", () => {
  it("keeps actor avatars backward compatible and accepts local attachment URLs", () => {
    const actor = {
      identity: { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" },
      name: "协作者",
    };
    expect(PrincipalSummarySchema.parse(actor)).toEqual(actor);
    expect(PrincipalSummarySchema.parse({ ...actor, avatarUrl: null })).toEqual({
      ...actor,
      avatarUrl: null,
    });
    expect(
      AttachmentViewSchema.parse({
        id: "20000000-0000-4000-8000-000000000001",
        taskId: "30000000-0000-4000-8000-000000000001",
        commentId: null,
        uploader: actor,
        filename: "证据.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        sha256: "a".repeat(64),
        createdAt: "2026-09-06T00:00:00.000Z",
        downloadUrl: "/api/v1/local/attachments/20000000-0000-4000-8000-000000000001",
      }).downloadUrl,
    ).toBe("/api/v1/local/attachments/20000000-0000-4000-8000-000000000001");
  });

  it("normalizes pagination input at the boundary", () => {
    expect(PaginationQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(() => PaginationQuerySchema.parse({ limit: 201 })).toThrow();
  });

  it("rejects invalid concurrency and idempotency values", () => {
    expect(() => ExpectedVersionSchema.parse({ expectedVersion: 0 })).toThrow();
    expect(() => IdempotencyKeySchema.parse("short")).toThrow();
  });

  it("keeps the originating board scope on task move commands", () => {
    const boardProjectId = "10000000-0000-4000-8000-000000000001";

    expect(
      MoveTaskCommandSchema.parse({
        expectedVersion: 1,
        targetStatus: "todo",
        boardProjectId,
      }),
    ).toEqual({ expectedVersion: 1, targetStatus: "todo", boardProjectId });
    expect(MoveTaskCommandSchema.parse({ expectedVersion: 1, targetStatus: "todo" })).toEqual({
      expectedVersion: 1,
      targetStatus: "todo",
    });
  });

  it("accepts only safe board event shapes", () => {
    const event = BoardEventSchema.parse({
      revision: 1,
      aggregateType: "task",
      aggregateId: "b5f24193-74d1-4535-8a70-d2f458127074",
      eventType: "task.created",
      safePayload: { title: "建立 SQLite 基础" },
      createdAt: "2026-08-30T10:00:00.000Z",
    });

    expect(event.eventType).toBe("task.created");
    expect(() => BoardEventSchema.parse({ ...event, revision: -1 })).toThrow();
  });

  it("validates event feed pages, cursors and refresh messages", () => {
    const projectId = "10000000-0000-4000-8000-000000000001";
    const taskId = "20000000-0000-4000-8000-000000000001";
    const query = EventFeedQuerySchema.parse({
      projectId,
      afterRevision: "4",
      limit: "25",
    });
    const event = BoardEventSchema.parse({
      revision: 5,
      aggregateType: "task",
      aggregateId: taskId,
      eventType: "task.updated",
      safePayload: { projectId, version: 2 },
      createdAt: "2026-08-30T12:00:00.000Z",
    });

    expect(query).toEqual({ projectId, afterRevision: 4, limit: 25 });
    expect(
      EventPageSchema.parse({
        events: [event],
        latestRevision: 5,
        cursorRevision: 5,
        earliestAvailableRevision: 1,
        hasMore: false,
        historyTruncated: false,
        cursorAhead: false,
      }),
    ).toMatchObject({ events: [event], cursorRevision: 5 });
    expect(
      EventStreamMessageSchema.parse({
        kind: "refresh_required",
        revision: 8,
        reason: "history_truncated",
      }),
    ).toEqual({ kind: "refresh_required", revision: 8, reason: "history_truncated" });
  });

  it("validates local project and runtime descriptor contracts", () => {
    expect(CreateProjectCommandSchema.parse({ projectKey: "LOCAL", name: "本机项目" })).toEqual({
      projectKey: "LOCAL",
      name: "本机项目",
      description: "",
    });
    expect(() =>
      CreateProjectCommandSchema.parse({ projectKey: "../unsafe", name: "非法项目" }),
    ).toThrow();
    expect(() =>
      RuntimeDescriptorSchema.parse({
        descriptorVersion: 1,
        pid: 1,
        generatedAt: "2026-08-30T12:00:00.000Z",
        publicBaseUrl: "http://127.0.0.1:47823",
        localAdminBaseUrl: "http://127.0.0.1:47824",
        capabilityToken: "short",
      }),
    ).toThrow();
  });

  it("locks Codex mirror project kinds and task reassignment commands", () => {
    expect(ProjectKindSchema.parse("codex")).toBe("codex");
    expect(ProjectKindSchema.parse("all")).toBe("all");
    expect(ProjectKindSchema.parse("temporary")).toBe("temporary");
    expect(() => ProjectKindSchema.parse("legacy")).toThrow();
    expect(
      ReassignTaskCommandSchema.parse({
        expectedVersion: 3,
        targetProjectId: "11111111-1111-4111-8111-111111111111",
        mode: "single",
      }),
    ).toEqual({
      expectedVersion: 3,
      targetProjectId: "11111111-1111-4111-8111-111111111111",
      mode: "single",
    });
    expect(() =>
      ReassignTaskCommandSchema.parse({
        expectedVersion: 3,
        targetProjectId: "11111111-1111-4111-8111-111111111111",
        mode: "all",
      }),
    ).toThrow();
  });

  it("allows no projectKey only for all projects and restricts visible keys to five letters", () => {
    const base = {
      id: "10000000-0000-4000-8000-000000000001",
      name: "项目",
      description: "",
      rootPaths: [] as string[],
      syncState: "synced" as const,
      membershipRole: null,
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
    };

    expect(ProjectViewSchema.parse({ ...base, kind: "all", projectKey: null })).toMatchObject({
      kind: "all",
      projectKey: null,
    });
    expect(
      ProjectViewSchema.parse({ ...base, kind: "temporary", projectKey: "TEMP" }),
    ).toMatchObject({ kind: "temporary", projectKey: "TEMP" });
    expect(
      ProjectViewSchema.parse({
        ...base,
        kind: "codex",
        projectKey: "LAUB",
        rootPaths: ["/Users/test/project"],
      }),
    ).toMatchObject({ kind: "codex", projectKey: "LAUB" });
    expect(() => ProjectViewSchema.parse({ ...base, kind: "codex", projectKey: null })).toThrow();
    expect(() => ProjectViewSchema.parse({ ...base, kind: "all", projectKey: "ALL" })).toThrow();
    expect(() =>
      ProjectViewSchema.parse({
        ...base,
        kind: "codex",
        projectKey: "TOOLONG",
        rootPaths: ["/Users/test/project"],
      }),
    ).toThrow();
  });

  it("requires project sync metadata and per-task permissions at public boundaries", () => {
    const project = {
      id: "10000000-0000-4000-8000-000000000001",
      projectKey: "CODEX",
      name: "同步项目",
      description: "",
      rootPaths: ["/Users/test/project"],
      syncState: "synced",
      membershipRole: "owner",
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
    };
    expect(() => ProjectViewSchema.parse(project)).toThrow();

    const task = {
      id: "20000000-0000-4000-8000-000000000001",
      identifier: "CODEX-1",
      projectId: project.id,
      taskNumber: 1,
      title: "同步任务",
      description: "",
      status: "todo",
      blockedFromStatus: null,
      priority: "none",
      labels: [],
      assigneeIdentity: null,
      creatorIdentity: null,
      startAt: null,
      dueAt: null,
      recurrence: null,
      developmentContextId: null,
      sortOrder: 1,
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
    };
    expect(() => TaskViewSchema.parse(task)).toThrow();
  });

  it("normalizes complete task commands and rejects invalid dates, labels and anchors", () => {
    expect(
      CreateTaskCommandSchema.parse({
        projectId: "10000000-0000-4000-8000-000000000001",
        title: " 任务五 ",
      }),
    ).toMatchObject({
      title: "任务五",
      description: "",
      status: "backlog",
      priority: "none",
      labels: [],
      assigneeIdentity: null,
    });
    expect(() =>
      CreateTaskCommandSchema.parse({
        projectId: "10000000-0000-4000-8000-000000000001",
        title: "错误日期",
        startAt: "2026-09-01T00:00:00.000Z",
        dueAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      CreateTaskCommandSchema.parse({
        projectId: "10000000-0000-4000-8000-000000000001",
        title: "重复标签",
        labels: ["后端", "后端"],
      }),
    ).toThrow();
    expect(() =>
      MoveTaskCommandSchema.parse({
        expectedVersion: 1,
        targetStatus: "todo",
        beforeTaskId: "10000000-0000-4000-8000-000000000002",
        afterTaskId: "10000000-0000-4000-8000-000000000002",
      }),
    ).toThrow();
  });

  it("defaults task links and initial relations when creating a task", () => {
    expect(
      CreateTaskCommandSchema.parse({
        projectId: "10000000-0000-4000-8000-000000000001",
        title: "带创建选项的任务",
      }),
    ).toMatchObject({
      links: [],
      initialRelations: {
        parentTaskId: null,
        childTaskId: null,
        relatedTaskIds: [],
      },
    });
  });

  it("rejects unsafe, duplicate and oversized task links", () => {
    const task = {
      projectId: "10000000-0000-4000-8000-000000000001",
      title: "链接校验",
    };

    expect(() =>
      CreateTaskCommandSchema.parse({ ...task, links: ["ftp://example.com"] }),
    ).toThrow();
    expect(() =>
      CreateTaskCommandSchema.parse({
        ...task,
        links: ["https://example.com/docs", "https://example.com/docs"],
      }),
    ).toThrow();
    expect(() =>
      CreateTaskCommandSchema.parse({
        ...task,
        links: [`https://example.com/${"a".repeat(2_030)}`],
      }),
    ).toThrow();
    expect(() =>
      CreateTaskCommandSchema.parse({
        ...task,
        links: Array.from({ length: 21 }, (_, index) => `https://example.com/${index}`),
      }),
    ).toThrow();
    expect(TaskLinkSchema.safeParse("not-a-url").success).toBe(false);
  });

  it("rejects overlapping initial task relation targets", () => {
    const task = {
      projectId: "10000000-0000-4000-8000-000000000001",
      title: "关联校验",
    };
    const firstTargetId = "20000000-0000-4000-8000-000000000001";
    const secondTargetId = "20000000-0000-4000-8000-000000000002";

    expect(() =>
      CreateTaskCommandSchema.parse({
        ...task,
        initialRelations: { parentTaskId: firstTargetId, childTaskId: firstTargetId },
      }),
    ).toThrow();
    expect(() =>
      CreateTaskCommandSchema.parse({
        ...task,
        initialRelations: { relatedTaskIds: [firstTargetId, firstTargetId] },
      }),
    ).toThrow();
    expect(() =>
      CreateTaskCommandSchema.parse({
        ...task,
        initialRelations: {
          parentTaskId: firstTargetId,
          relatedTaskIds: [firstTargetId, secondTargetId],
        },
      }),
    ).toThrow();
  });

  it("requires task links in public task views and exposes project creation options", () => {
    const task = {
      id: "20000000-0000-4000-8000-000000000001",
      identifier: "CODEX-1",
      projectId: "10000000-0000-4000-8000-000000000001",
      projectName: "同步项目",
      originProjectName: null,
      codexThreadState: "none",
      permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
      taskNumber: 1,
      title: "同步任务",
      description: "",
      status: "todo",
      blockedFromStatus: null,
      priority: "none",
      labels: [],
      assigneeIdentity: null,
      creatorIdentity: null,
      startAt: null,
      dueAt: null,
      recurrence: null,
      developmentContextId: null,
      sortOrder: 1,
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
    };

    expect(TaskViewSchema.parse(task)).toMatchObject({ links: [] });
    expect(TaskViewSchema.parse(task)).not.toHaveProperty("workingDirectory");
    expect(
      TaskViewSchema.parse({ ...task, workingDirectory: "/fixture/task-worktree" }),
    ).toMatchObject({ workingDirectory: "/fixture/task-worktree" });
    expect(TaskViewSchema.parse({ ...task, workingDirectory: null })).toMatchObject({
      workingDirectory: null,
    });

    expect(
      ProjectTaskCreationOptionsViewSchema.parse({
        projectId: task.projectId,
        currentIdentity: { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" },
        assignees: [
          {
            identity: { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" },
            name: "当前用户",
            avatarUrl: "https://example.com/avatar.png",
            actorRole: "member",
            projectRole: null,
          },
        ],
        labels: [],
        developmentContexts: [],
        defaultDevelopmentContext: { id: null, label: "无", branch: null },
        relationCandidates: [],
        attachmentMaxBytes: 25 * 1024 * 1024,
      }),
    ).toEqual({
      projectId: task.projectId,
      currentIdentity: { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" },
      assignees: [
        {
          identity: { kind: "feishu", tenantKey: "tenant-a", userId: "user-1" },
          name: "当前用户",
          avatarUrl: "https://example.com/avatar.png",
          actorRole: "member",
          projectRole: null,
        },
      ],
      labels: [],
      developmentContexts: [],
      defaultDevelopmentContext: { id: null, label: "无", branch: null },
      relationCandidates: [],
      attachmentMaxBytes: 25 * 1024 * 1024,
    });
  });

  it("locks blocked origins and physical deletion commands", () => {
    const task = {
      id: "20000000-0000-4000-8000-000000000001",
      identifier: "CODEX-1",
      projectId: "10000000-0000-4000-8000-000000000001",
      projectName: "同步项目",
      originProjectName: null,
      codexThreadState: "none",
      permissions: { canRead: true, canWrite: true, canExecute: true, canReassign: false },
      taskNumber: 1,
      title: "阻塞任务",
      description: "",
      status: "blocked",
      blockedFromStatus: "in_review",
      priority: "none",
      labels: [],
      assigneeIdentity: null,
      creatorIdentity: null,
      startAt: null,
      dueAt: null,
      recurrence: null,
      developmentContextId: null,
      links: [],
      sortOrder: 1,
      version: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
    };

    expect(TaskViewSchema.parse(task).blockedFromStatus).toBe("in_review");
    expect(() =>
      TaskViewSchema.parse({ ...task, status: "done", blockedFromStatus: "todo" }),
    ).toThrow();
    expect(DeleteTaskCommandSchema.parse({ expectedVersion: 3 })).toEqual({ expectedVersion: 3 });
    expect(() => DeleteTaskCommandSchema.parse({ expectedVersion: 0 })).toThrow();
  });

  it("validates global label commands, ordering and views", () => {
    const firstId = "40000000-0000-4000-8000-000000000001";
    const secondId = "40000000-0000-4000-8000-000000000002";

    expect(CreateGlobalLabelCommandSchema.parse({ name: "  前端  " })).toEqual({ name: "前端" });
    expect(UpdateGlobalLabelCommandSchema.parse({ expectedVersion: 2, name: "  设计  " })).toEqual({
      expectedVersion: 2,
      name: "设计",
    });
    expect(ReorderGlobalLabelsCommandSchema.parse({ labelIds: [secondId, firstId] })).toEqual({
      labelIds: [secondId, firstId],
    });
    expect(() =>
      ReorderGlobalLabelsCommandSchema.parse({ labelIds: [firstId, firstId] }),
    ).toThrow();
    expect(
      GlobalLabelListViewSchema.parse({
        labels: [
          {
            id: firstId,
            name: "前端",
            sortOrder: 0,
            version: 1,
            createdAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:00.000Z",
          },
        ],
      }).labels[0]?.name,
    ).toBe("前端");
  });

  it("validates comment, relation and task workspace contracts", () => {
    expect(CreateCommentCommandSchema.parse({ body: "  **已验证**  " })).toEqual({
      body: "**已验证**",
    });
    expect(() => CreateCommentCommandSchema.parse({ body: "   " })).toThrow();
    expect(() =>
      CreateTaskRelationCommandSchema.parse({
        relationType: "unknown",
        targetTaskId: "10000000-0000-4000-8000-000000000002",
      }),
    ).toThrow();
    expect(() =>
      TaskWorkspaceViewSchema.parse({
        task: {},
        comments: [],
        attachments: [{ storageKey: "must-not-leak" }],
        relations: [],
        activities: [],
        executionSummary: { total: 0, active: 0, latest: null },
      }),
    ).toThrow();
  });

  it("validates the local-only operations snapshot without accepting secret fields", () => {
    const snapshot = LocalOperationsSnapshotSchema.parse({
      status: "degraded",
      timestamp: "2026-08-31T08:00:00.000Z",
      checks: {
        http: { status: "ok" },
        sqlite: { status: "ok" },
        queue: { status: "degraded", reason: "存在需要人工重试的作业" },
        connector: { status: "unavailable", reason: "Connector 未连接" },
        appServer: { status: "ok" },
      },
      metrics: {
        requests: { total: 12, inFlight: 1, errors: 2 },
        queue: {
          queued: 1,
          running: 0,
          waitingApproval: 0,
          waitingInput: 0,
          canceling: 0,
          failedRecoverable: 1,
        },
      },
    });

    expect(snapshot.checks.queue.status).toBe("degraded");
    expect(() =>
      LocalOperationsSnapshotSchema.parse({
        ...snapshot,
        capabilityToken: "must-not-be-accepted",
      }),
    ).toThrow();
  });
});

it("accepts multiple initial children and rejects duplicates or conflicting relation roles", () => {
  const first = "10000000-0000-4000-8000-000000000002";
  const second = "10000000-0000-4000-8000-000000000003";
  const base = { projectId: "10000000-0000-4000-8000-000000000001", title: "多子任务" };
  expect(
    CreateTaskCommandSchema.parse({ ...base, initialRelations: { childTaskIds: [first, second] } })
      .initialRelations.childTaskIds,
  ).toEqual([first, second]);
  for (const initialRelations of [
    { childTaskIds: [first, first] },
    { parentTaskId: first, childTaskIds: [first] },
    { childTaskId: first, childTaskIds: [first] },
    { childTaskIds: [first], relatedTaskIds: [first] },
  ])
    expect(() => CreateTaskCommandSchema.parse({ ...base, initialRelations })).toThrow();
});
