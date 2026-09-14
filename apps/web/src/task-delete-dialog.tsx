import { userErrorMessage } from "./user-error";
import { Notice } from "./notification-center";
import type { TaskView } from "@lark-taskboard/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ApiError, deleteTask } from "./api";
import { SfSymbol } from "./sf-symbol";
import { invalidateTaskDeletionQueries } from "./task-delete-cache";
import { createUuid } from "./random-id";

function newIdempotencyKey(): string {
  return createUuid();
}

function errorMessage(error: unknown): string {
  return userErrorMessage(error, "任务删除失败");
}

export function TaskDeleteDialog({
  csrfToken,
  onClose,
  onDeleted,
  task,
}: {
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDeleted: (task: TaskView) => void;
  readonly task: TaskView;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const idempotencyKeyRef = useRef(newIdempotencyKey());
  const queryClient = useQueryClient();
  const [archiveThreadId, setArchiveThreadId] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => deleteTask(task.id, task.version, csrfToken, idempotencyKeyRef.current),
    onMutate: () => setArchiveThreadId(null),
    onError: (error) => {
      if (
        !window.matchMedia("(max-width: 767px), (hover: none), (pointer: coarse)").matches &&
        error instanceof ApiError &&
        error.details?.reason === "CODEX_DESKTOP_THREAD_BUSY" &&
        typeof error.details.threadId === "string" &&
        error.details.threadId.length > 0
      ) {
        setArchiveThreadId(error.details.threadId);
      }
    },
    onSuccess: async () => {
      await invalidateTaskDeletionQueries(queryClient);
      queryClient.removeQueries({ queryKey: ["task", task.id] });
      queryClient.removeQueries({ queryKey: ["workspace", task.id] });
      onDeleted(task);
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [archiveThreadId]);

  return (
    <>
      {mutation.isError && (
        <Notice message={errorMessage(mutation.error)} eventKey={mutation.error} />
      )}
      {archiveThreadId ? (
        <DesktopBusyDialog threadId={archiveThreadId} onClose={() => setArchiveThreadId(null)} />
      ) : (
        <dialog
          ref={dialogRef}
          className="task-delete-dialog-shell"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="task-delete-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!mutation.isPending) onClose();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget && !mutation.isPending) onClose();
          }}
        >
          <section className="task-delete-dialog">
            <div className="task-delete-dialog__icon">
              <SfSymbol name="trash" size={20} />
            </div>
            <div className="task-delete-dialog__body">
              <h2 id="task-delete-title">彻底删除 {task.identifier}？</h2>
              <p>
                关联的 Codex 原始任务将先归档，然后永久删除 Lark-Codex
                中的任务、评论、附件与执行记录。
              </p>
              <strong>{task.title}</strong>
              <div className="task-delete-dialog__actions">
                <button
                  type="button"
                  className="button"
                  disabled={mutation.isPending}
                  onClick={onClose}
                >
                  保留任务
                </button>
                <button
                  type="button"
                  className="button button--danger task-delete-confirm"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate()}
                >
                  {mutation.isPending ? (
                    <SfSymbol name="arrow.triangle.2.circlepath" className="spin" />
                  ) : (
                    <SfSymbol name="trash" />
                  )}
                  {mutation.isPending ? "正在删除…" : "永久删除"}
                </button>
              </div>
            </div>
          </section>
        </dialog>
      )}
    </>
  );
}

function DesktopBusyDialog({
  threadId,
  onClose,
}: {
  readonly threadId: string;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="task-delete-dialog-shell"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="desktop-busy-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="task-delete-dialog">
        <div className="task-delete-dialog__icon">
          <SfSymbol name="exclamationmark.triangle" size={20} />
        </div>
        <div className="task-delete-dialog__body">
          <h2 id="desktop-busy-title">Codex 对话仍被占用</h2>
          <p>
            原始对话仍被 Codex Desktop
            占用，任务尚未删除。是否打开对应对话进行归档？归档后请返回删除确认窗口，点击“永久删除”重试。
          </p>
          <div className="task-delete-dialog__actions">
            <button type="button" className="button" autoFocus onClick={onClose}>
              暂不跳转
            </button>
            <a
              className="button button--primary"
              href={`codex://threads/${encodeURIComponent(threadId)}`}
              onClick={onClose}
            >
              打开 Codex 对话
            </a>
          </div>
        </div>
      </section>
    </dialog>
  );
}
