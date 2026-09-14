import type { TaskView } from "@lark-codex/contracts";
import { useMemo, useState } from "react";

import { SfSymbol } from "./sf-symbol";
import { TaskRestoreButton } from "./task-restore-button";
import { groupTasksForWorkspace, TASK_STATUS_META } from "./task-status";

type ArchiveTab = "done" | "canceled";
const ARCHIVE_STATUSES = ["done", "canceled"] as const;

export function TaskArchiveDrawer({
  initialTab = "done",
  onClosed,
  onDeleteTask,
  onOpenTask,
  open,
  tasks,
  csrfToken,
  mutationsEnabled = true,
}: {
  readonly initialTab?: ArchiveTab;
  readonly onClosed?: () => void;
  readonly onDeleteTask: (task: TaskView) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly open: boolean;
  readonly tasks: readonly TaskView[];
  readonly csrfToken?: string;
  readonly mutationsEnabled?: boolean;
}) {
  const [tab, setTab] = useState<ArchiveTab>(initialTab);
  const archive = useMemo(() => groupTasksForWorkspace(tasks).archive, [tasks]);
  const visibleTasks = archive[tab];

  return (
    <aside
      className={
        open
          ? "status-column status-column--archive archive-drawer archive-drawer--open"
          : "status-column status-column--archive archive-drawer"
      }
      aria-label="其他任务"
      aria-hidden={!open}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "transform" && !open) {
          onClosed?.();
        }
      }}
    >
      <header className="status-header other-tasks-header">
        <h2>其他任务</h2>
      </header>
      <div className="archive-tabs" role="tablist" aria-label="其他任务状态">
        {ARCHIVE_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={tab === status}
            onClick={() => setTab(status)}
          >
            <SfSymbol name={TASK_STATUS_META[status].symbol} size={14} />
            {TASK_STATUS_META[status].label} {archive[status].length}
          </button>
        ))}
      </div>
      <div className="task-stack archive-task-list">
        {visibleTasks.length ? (
          visibleTasks.map((task) => (
            <article className="task-card archive-task-card" key={task.id}>
              <button
                type="button"
                className="task-open archive-task-open"
                onClick={() => onOpenTask(task.id)}
              >
                <span className="task-identifier">{task.identifier}</span>
                <strong>{task.title}</strong>
              </button>
              <footer className="task-card-actions archive-task-actions">
                <div className="task-labels">
                  {task.labels.slice(0, 2).map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
                {task.permissions.canWrite ? (
                  <>
                    {task.status === "canceled" && csrfToken && (
                      <TaskRestoreButton
                        task={task}
                        csrfToken={csrfToken}
                        enabled={mutationsEnabled}
                      />
                    )}
                    <button
                      type="button"
                      className="advance-button archive-task-delete"
                      aria-label={`彻底删除任务 ${task.identifier}`}
                      onClick={() => onDeleteTask(task)}
                    >
                      <SfSymbol name="trash" />
                    </button>
                  </>
                ) : null}
              </footer>
            </article>
          ))
        ) : (
          <div className="archive-drawer__empty">
            <SfSymbol name={TASK_STATUS_META[tab].symbol} size={20} />
            <strong>暂无任务</strong>
            <span>当前没有匹配的{TASK_STATUS_META[tab].label}任务。</span>
          </div>
        )}
      </div>
    </aside>
  );
}
