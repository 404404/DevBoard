import { userErrorMessage } from "./user-error";
import { Notice } from "./notification-center";
import type { TaskLifecycleView, TaskView } from "@codexboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { readTaskWorkspace, requestTaskLifecycle } from "./api";
import { SfSymbol } from "./sf-symbol";
import { TaskRestoreButton } from "./task-restore-button";
import { createUuid } from "./random-id";

const PHASE_LABELS: Record<TaskLifecycleView["phase"], string> = {
  checking: "检查任务与工作区…",
  canceling: "等待 Codex 停止…",
  committing: "提交改动并清理任务临时文件…",
  cleaning: "保存提交记录并清理独占工作区…",
  completed: "操作已完成",
};

export function TaskLifecycleActions({
  task,
  csrfToken,
  enabled,
  onAccepted,
  operation,
  onInitiate,
  initiateEnabled,
}: {
  readonly task: TaskView;
  readonly csrfToken: string;
  readonly enabled: boolean;
  readonly onAccepted: () => void;
  readonly onInitiate: () => void;
  readonly initiateEnabled: boolean;
  readonly operation: TaskLifecycleView | null | undefined;
}) {
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace", task.id],
    queryFn: () => readTaskWorkspace(task.id),
  });
  const mutation = useMutation({
    mutationFn: (targetStatus: "done" | "canceled") =>
      requestTaskLifecycle(
        task.id,
        { expectedVersion: task.version, targetStatus },
        csrfToken,
        createUuid(),
      ),
    onSuccess(result) {
      queryClient.setQueryData(["lifecycle", task.id], result);
      void queryClient.invalidateQueries({ queryKey: ["jobs", task.id] });
      onAccepted();
    },
  });
  useEffect(() => {
    if (operation?.status !== "succeeded") return;
    for (const key of [
      ["task", task.id],
      ["workspace", task.id],
      ["jobs", task.id],
      ["board"],
      ["dashboard"],
    ]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [operation?.id, operation?.status, queryClient, task.id]);
  const running = operation?.status === "pending" || operation?.status === "running";
  const failed = operation?.status === "failed";
  const unexecuted =
    workspace.data?.comments.some(
      (comment) => comment.source === "user" && !comment.executedAt && !comment.deletedAt,
    ) ?? false;
  const active = (workspace.data?.executionSummary.active ?? 0) > 0;
  const completeReason =
    task.status !== "in_review"
      ? "仅待验收状态可完成任务"
      : active
        ? "请先取消或等待执行结束"
        : unexecuted
          ? "请先处理未执行的评论"
          : undefined;
  return (
    <section className="task-lifecycle-actions" aria-label="任务收尾">
      <div className="task-lifecycle-buttons">
        {task.status === "backlog" && (
          <button
            type="button"
            className="button button--primary"
            disabled={!enabled || !initiateEnabled || running || mutation.isPending}
            onClick={onInitiate}
          >
            <SfSymbol name="checkmark.circle.fill" size={16} />
            立项
          </button>
        )}
        {task.status === "canceled" ? (
          <TaskRestoreButton task={task} csrfToken={csrfToken} enabled={enabled && !running} />
        ) : (
          <button
            type="button"
            className="button button--danger"
            disabled={!enabled || running || mutation.isPending}
            onClick={() => {
              mutation.reset();
              mutation.mutate("canceled");
            }}
          >
            <SfSymbol name="xmark.circle.fill" size={16} />
            {task.status === "backlog"
              ? "取消"
              : failed && operation.targetStatus === "canceled"
                ? "重试取消任务"
                : "取消任务"}
          </button>
        )}
        {task.status !== "backlog" && (
          <button
            type="button"
            className="button button--primary"
            title={completeReason}
            disabled={
              !enabled ||
              running ||
              mutation.isPending ||
              task.status === "done" ||
              workspace.isPending ||
              workspace.isError ||
              Boolean(completeReason)
            }
            onClick={() => {
              mutation.reset();
              mutation.mutate("done");
            }}
          >
            <SfSymbol name="checkmark.circle.fill" size={16} />
            {failed && operation.targetStatus === "done" ? "重试任务收尾" : "任务完成"}
          </button>
        )}
      </div>
      {running && <p role="status">{PHASE_LABELS[operation.phase]}</p>}
      {failed && <Notice message="任务操作失败，请重试。" eventKey={operation.updatedAt} />}
      {mutation.isError && (
        <Notice message={userErrorMessage(mutation.error)} eventKey={mutation.error} />
      )}
      {task.status !== "backlog" && !running && completeReason && (
        <p className="muted">{completeReason}</p>
      )}
      {operation?.status === "succeeded" && operation.targetStatus === "done" && (
        <div className="task-completion-result" role="status">
          <p>
            任务收尾已完成{operation.commitSha ? `，提交 ${operation.commitSha.slice(0, 8)}` : ""}
          </p>
          {operation.archiveRef && (
            <p>
              提交保留于 <code>{operation.archiveRef}</code>
            </p>
          )}
          {operation.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
    </section>
  );
}
