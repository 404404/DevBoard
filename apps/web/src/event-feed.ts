import { ALL_PROJECT_ID, BoardEventSchema, type BoardEvent } from "@codexboard/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { readCodexBoardStorage } from "./brand-storage";

export type RealtimeState = "connecting" | "live" | "reconnecting" | "offline";

export function visibleRealtimeState(
  projectId: string | undefined,
  state: RealtimeState,
): RealtimeState | undefined {
  return projectId ? state : undefined;
}

const TASK_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.deleted",
  "task.creation_failed",
  "task.lifecycle_updated",
  "task.lifecycle_completed",
  "task.comments_executed",
] as const;

const EXECUTION_EVENT_TYPES = [
  "job.queued",
  "job.running",
  "job.waiting_approval",
  "job.waiting_input",
  "job.interaction_resolved",
  "job.retry_queued",
  "job.succeeded",
  "job.failed",
  "job.failed_recoverable",
  "job.outcome_unknown",
  "job.result_corrected",
  "job.capacity_waiting",
  "job.canceling",
  "job.canceled",
  "codex.agent_message",
  "codex.history_synced",
  "codex.thread_created",
  "codex.thread_bound",
  "codex.turn_started",
  "codex.command",
  "codex.file_change",
  "codex.error",
  "codex.notification",
  "interaction.requested",
  "interaction.responded",
] as const;

const WORKSPACE_EVENT_TYPES = [
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "relation.created",
  "relation.deleted",
] as const;

const DASHBOARD_EVENT_TYPES = ["task.read"] as const;

const PROJECT_EVENT_TYPES = [
  "project.sync_created",
  "project.sync_updated",
  "project.sync_adopted",
  "project.sync_deleted",
  "project.sync_restored",
] as const;

const LABEL_EVENT_TYPES = [
  "label.created",
  "label.updated",
  "label.deleted",
  "label.reordered",
] as const;

function cursorKey(projectId: string): string {
  return `codexboard:event-revision:${projectId}`;
}

type QueryKey = readonly unknown[];

export function taskMutationInvalidationKeys(
  projectId: string,
  taskIds: readonly string[],
): QueryKey[] {
  const uniqueTaskIds = [...new Set(taskIds.filter(Boolean))];
  return [
    ["board", projectId],
    ["dashboard", projectId],
    ...uniqueTaskIds.flatMap((taskId) => [
      ["task", taskId],
      ["workspace", taskId],
    ]),
  ];
}

function isEventType(eventType: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => candidate === eventType);
}

export function eventInvalidationKeys(projectId: string, event: BoardEvent): QueryKey[] {
  if (event.aggregateType === "run" || event.eventType.startsWith("run.")) {
    const taskId = typeof event.safePayload.taskId === "string" ? event.safePayload.taskId : undefined;
    return [
      ["board", projectId],
      ["dashboard", projectId],
      ["task-runs"],
      ["run-approvals"],
      ...(taskId ? [["task-runs", taskId]] as const : []),
    ];
  }
  if (event.aggregateType === "milestone" || event.eventType.startsWith("milestone.")) {
    return [["dashboard", projectId], ["project-milestones", projectId]];
  }
  if (event.eventType === "project.execution_profile.updated") {
    return [["project-execution-profile", projectId], ["task-runs"]];
  }
  if (event.eventType === "task.workspace_synced") {
    const taskId = event.aggregateId;
    return [
      ...taskMutationInvalidationKeys(projectId, taskId ? [taskId] : []),
      ["task-creation-options", projectId],
      ["git-management", projectId],
    ];
  }
  if (isEventType(event.eventType, LABEL_EVENT_TYPES)) {
    return [["labels"], ["task-creation-options"], ["board", projectId], ["task"], ["workspace"]];
  }
  if (isEventType(event.eventType, PROJECT_EVENT_TYPES)) {
    return [["projects"], ["board"], ["dashboard"], ["task"], ["workspace"]];
  }
  if (isEventType(event.eventType, TASK_EVENT_TYPES)) {
    const taskId = event.aggregateType === "task" ? event.aggregateId : null;
    return [
      ["board", projectId],
      ["dashboard", projectId],
      ["project-milestones", projectId],
      ...(taskId
        ? ([
            ["task", taskId],
            ["workspace", taskId],
            ["lifecycle", taskId],
          ] as const)
        : []),
    ];
  }
  if (isEventType(event.eventType, EXECUTION_EVENT_TYPES)) {
    const taskId =
      typeof event.safePayload.taskId === "string" ? event.safePayload.taskId : undefined;
    const jobId =
      typeof event.safePayload.jobId === "string"
        ? event.safePayload.jobId
        : event.aggregateType === "job"
          ? event.aggregateId
          : null;
    return [
      ["board", projectId],
      ["dashboard", projectId],
      ["project-milestones", projectId],
      ...(taskId
        ? ([
            ["task", taskId],
            ["jobs", taskId],
            ["workspace", taskId],
          ] as const)
        : []),
      ...(jobId ? ([["interactions", jobId]] as const) : []),
    ];
  }
  if (isEventType(event.eventType, WORKSPACE_EVENT_TYPES)) {
    const taskId =
      typeof event.safePayload.taskId === "string" ? event.safePayload.taskId : undefined;
    const relatedTaskId =
      typeof event.safePayload.relatedTaskId === "string"
        ? event.safePayload.relatedTaskId
        : undefined;
    if (event.eventType === "relation.created" || event.eventType === "relation.deleted") {
      return taskMutationInvalidationKeys(
        projectId,
        [taskId, relatedTaskId].filter((id): id is string => id !== undefined),
      );
    }
    return [["dashboard", projectId], ...(taskId ? ([["workspace", taskId]] as const) : [])];
  }
  if (isEventType(event.eventType, DASHBOARD_EVENT_TYPES)) {
    return [["dashboard", projectId]];
  }
  return [];
}

export function fullRefreshQueryKeys(projectId: string): QueryKey[] {
  return [
    ["projects"],
    ["labels"],
    ["task-creation-options"],
    ["board", projectId],
    ["dashboard", projectId],
    ["task"],
    ["workspace"],
    ["jobs"],
    ["interactions"],
    ["task-runs"],
    ["run-approvals"],
    ["project-milestones"],
    ["project-execution-profile"],
  ];
}

export function cursorInvalidationKeys(projectId: string): QueryKey[] {
  // The aggregate stream receives cursor-only notifications for owner-project events.
  // Re-read through authenticated endpoints rather than exposing cross-project payloads.
  return projectId === ALL_PROJECT_ID ? fullRefreshQueryKeys(projectId) : [];
}

export function useProjectEvents(projectId: string | undefined): RealtimeState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RealtimeState>(() =>
    navigator.onLine ? "connecting" : "offline",
  );

  useEffect(() => {
    if (!projectId) {
      return;
    }

    let source: EventSource | undefined;
    let disposed = false;
    const rememberCursor = (event: MessageEvent<string>) => {
      if (event.lastEventId) {
        window.sessionStorage.setItem(cursorKey(projectId), event.lastEventId);
      }
    };
    const refreshEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      rememberCursor(message);
      let payload: unknown;
      try {
        payload = JSON.parse(message.data) as unknown;
      } catch {
        return;
      }
      const parsed = BoardEventSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      for (const queryKey of eventInvalidationKeys(projectId, parsed.data)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const refreshAll = (event: Event) => {
      rememberCursor(event as MessageEvent<string>);
      for (const queryKey of fullRefreshQueryKeys(projectId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const rememberOnly = (event: Event) => {
      rememberCursor(event as MessageEvent<string>);
      for (const queryKey of cursorInvalidationKeys(projectId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const open = () => {
      source?.close();
      if (disposed || !navigator.onLine) {
        setState("offline");
        return;
      }
      setState("connecting");
      const afterRevision =
        readCodexBoardStorage(window.sessionStorage, `event-revision:${projectId}`) ?? "0";
      source = new EventSource(
        `/api/v1/events?projectId=${encodeURIComponent(projectId)}&afterRevision=${encodeURIComponent(afterRevision)}`,
      );
      source.onopen = () => setState("live");
      source.onerror = () => setState(navigator.onLine ? "reconnecting" : "offline");
      for (const eventType of TASK_EVENT_TYPES) {
        source.addEventListener(eventType, refreshEvent);
      }
      for (const eventType of EXECUTION_EVENT_TYPES) {
        source.addEventListener(eventType, refreshEvent);
      }
      for (const eventType of WORKSPACE_EVENT_TYPES) {
        source.addEventListener(eventType, refreshEvent);
      }
      for (const eventType of DASHBOARD_EVENT_TYPES) {
        source.addEventListener(eventType, refreshEvent);
      }
      for (const eventType of PROJECT_EVENT_TYPES) {
        source.addEventListener(eventType, refreshEvent);
      }
      for (const eventType of LABEL_EVENT_TYPES) {
        source.addEventListener(eventType, refreshEvent);
      }
      source.addEventListener("refresh-required", refreshAll);
      source.addEventListener("cursor", rememberOnly);
    };
    const handleOffline = () => {
      source?.close();
      setState("offline");
    };
    const handleOnline = () => {
      for (const queryKey of fullRefreshQueryKeys(projectId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
      open();
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    open();
    return () => {
      disposed = true;
      source?.close();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [projectId, queryClient]);

  return projectId ? state : navigator.onLine ? "connecting" : "offline";
}
