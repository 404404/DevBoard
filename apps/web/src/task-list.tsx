import { userErrorMessage } from "./user-error";
import { sameIdentity } from "@lark-codex/contracts";
import { Notice } from "./notification-center";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import type {
  PrincipalView,
  ProjectKind,
  TaskPriority,
  TaskStatus,
  TaskView,
} from "@lark-codex/contracts";

import { updateTask } from "./api";
import { priorityLabel } from "./locale";
import { taskProjectContext } from "./project-sync";
import { SfSymbol } from "./sf-symbol";
import { PriorityIcon } from "./priority-icon";
import { applyTaskUpdate } from "./task-move-cache";
import { TASK_STATUS_META, TASK_STATUS_ORDER } from "./task-status";
import { createUuid } from "./random-id";
import "./task-list.css";

interface TaskListPanelProps {
  readonly tasks: readonly TaskView[];
  readonly projectKind: ProjectKind;
  readonly onOpen: (id: string) => void;
  readonly csrfToken: string;
  readonly writable: boolean;
  readonly actors: readonly PrincipalView[];
  readonly hasActiveFilters: boolean;
}

const PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
const createdDate = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const dueDate = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

function PriorityPicker({
  task,
  disabled,
  onChange,
}: {
  readonly task: TaskView;
  readonly disabled: boolean;
  readonly onChange: (priority: TaskPriority) => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const isOpen = position !== null;

  useEffect(() => {
    if (!isOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      ) {
        setPosition(null);
      }
    }
    function reposition() {
      setPosition(null);
    }
    function onScroll(event: Event) {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setPosition(null);
    }
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
    };
  }, [isOpen]);

  function open() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const height = 160;
    setPosition({
      left: Math.max(8, Math.min(rect.right - 144, window.innerWidth - 152)),
      top:
        rect.bottom + height + 8 <= window.innerHeight
          ? rect.bottom + 5
          : Math.max(8, rect.top - height - 5),
    });
  }

  function close() {
    setPosition(null);
    trigger.current?.focus();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`issue-list-priority priority-${task.priority}`}
        title={priorityLabel(task.priority)}
        aria-label={`${task.identifier} 优先级`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        disabled={disabled}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            open();
          }
        }}
      >
        <PriorityIcon priority={task.priority} />
        <span>{priorityLabel(task.priority)}</span>
      </button>
      {position &&
        createPortal(
          <div className="issue-list-view" style={{ display: "contents" }}>
            <div
              ref={menu}
              id={menuId}
              className="issue-list-priority-menu"
              role="listbox"
              aria-label={`${task.identifier} 优先级选项`}
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                right: "auto",
                zIndex: 1000,
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                  return;
                }
                if (event.key === "Tab") {
                  close();
                  return;
                }
                const options = Array.from(
                  menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
                );
                const current = options.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "ArrowDown"
                    ? (current + 1) % options.length
                    : event.key === "ArrowUp"
                      ? (current - 1 + options.length) % options.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? options.length - 1
                          : -1;
                if (next >= 0) {
                  event.preventDefault();
                  options[next]?.focus();
                }
              }}
            >
              {PRIORITIES.map((priority) => (
                <button
                  key={priority}
                  type="button"
                  role="option"
                  className={`priority-${priority}`}
                  aria-selected={task.priority === priority}
                  tabIndex={-1}
                  onClick={() => {
                    close();
                    onChange(priority);
                  }}
                >
                  <PriorityIcon priority={priority} />
                  <span>{priorityLabel(priority)}</span>
                  {task.priority === priority && <SfSymbol name="checkmark" size={12} />}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function TaskListPanel({
  tasks,
  projectKind,
  onOpen,
  csrfToken,
  writable,
  actors,
  hasActiveFilters,
}: TaskListPanelProps) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(
    () => new Set<TaskStatus>(["backlog", "done", "canceled"]),
  );
  const [overrides, setOverrides] = useState<Record<string, TaskView>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingIds = useRef(new Set<string>());
  const [error, setError] = useState("");

  async function changePriority(task: TaskView, priority: TaskPriority) {
    if (
      !writable ||
      !task.permissions.canWrite ||
      pendingIds.current.has(task.id) ||
      task.priority === priority
    )
      return;
    pendingIds.current.add(task.id);
    setPending(new Set(pendingIds.current));
    setError("");
    setOverrides((current) => ({ ...current, [task.id]: { ...task, priority } }));
    try {
      const updated = await updateTask(
        task.id,
        { expectedVersion: task.version, priority },
        csrfToken,
        createUuid(),
      );
      await queryClient.cancelQueries({ queryKey: ["task", task.id], exact: true });
      applyTaskUpdate(queryClient, updated);
      setOverrides((current) => ({ ...current, [task.id]: updated }));
      void queryClient.invalidateQueries({ queryKey: ["board"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (cause) {
      setOverrides((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      setError(userErrorMessage(cause, "优先级保存失败，请重试。"));
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    } finally {
      pendingIds.current.delete(task.id);
      setPending(new Set(pendingIds.current));
    }
  }

  return (
    <div className="issue-list-view" aria-label="任务列表">
      {error && <Notice message={error} />}
      <div className="issue-list-groups">
        {TASK_STATUS_ORDER.map((status) => {
          const statusTasks = tasks.filter((task) => task.status === status);
          const isCollapsed = collapsed.has(status);
          const meta = TASK_STATUS_META[status];
          return (
            <section className={`issue-list-group status-${status}`} key={status}>
              <button
                className="issue-list-group-header"
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(status)) next.delete(status);
                    else next.add(status);
                    return next;
                  })
                }
              >
                <span className={`issue-list-chevron${isCollapsed ? "" : " is-expanded"}`}>
                  <SfSymbol name="chevron.right" size={12} />
                </span>
                <span className="issue-list-status-icon">
                  <SfSymbol name={meta.symbol} size={14} />
                </span>
                <strong>{meta.label}</strong>
                <span>{statusTasks.length}</span>
              </button>
              {!isCollapsed && (
                <div className="issue-list-rows">
                  {statusTasks.length ? (
                    statusTasks.map((source) => {
                      const override = overrides[source.id];
                      const task =
                        override && override.version >= source.version ? override : source;
                      const actor =
                        task.assignee ??
                        actors.find(({ identity }) =>
                          sameIdentity(identity, task.assigneeIdentity),
                        );
                      const context = taskProjectContext(task, projectKind);
                      return (
                        <div
                          className="issue-list-row"
                          role="button"
                          tabIndex={0}
                          key={task.id}
                          aria-label={`${task.identifier} ${task.title}`}
                          onClick={() => onOpen(task.id)}
                          onKeyDown={(event) => {
                            if (
                              event.target === event.currentTarget &&
                              (event.key === "Enter" || event.key === " ")
                            ) {
                              event.preventDefault();
                              onOpen(task.id);
                            }
                          }}
                        >
                          <span
                            className="issue-list-title-cell"
                            title={context ? `${task.title} · ${context}` : task.title}
                          >
                            <small>{task.identifier}</small>
                            <strong>{task.title}</strong>
                          </span>
                          <span className="issue-list-metadata" aria-label="任务属性">
                            <span
                              className="issue-list-priority-control"
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              <PriorityPicker
                                task={task}
                                disabled={
                                  !writable || !task.permissions.canWrite || pending.has(task.id)
                                }
                                onChange={(priority) => void changePriority(task, priority)}
                              />
                            </span>
                            <span className="issue-list-labels">
                              {task.labels.slice(0, 2).map((label) => (
                                <i key={label} title={label}>
                                  <b>{label}</b>
                                </i>
                              ))}
                              {task.labels.length > 2 && (
                                <b title={task.labels.slice(2).join("、")}>
                                  +{task.labels.length - 2}
                                </b>
                              )}
                            </span>
                            {task.dueAt && (
                              <span
                                className="issue-list-date"
                                title={`截止于 ${new Date(task.dueAt).toLocaleString("zh-CN")}`}
                              >
                                <SfSymbol name="clock" size={12} />
                                <span>{dueDate.format(new Date(task.dueAt))}</span>
                              </span>
                            )}
                            <span
                              className="issue-list-assignee"
                              title={
                                actor?.name ??
                                (task.assigneeIdentity ? "负责人信息暂不可用" : "未分配负责人")
                              }
                              aria-label={
                                actor
                                  ? `负责人：${actor.name}`
                                  : task.assigneeIdentity
                                    ? "负责人信息暂不可用"
                                    : "未分配负责人"
                              }
                            >
                              {actor?.avatarUrl ? (
                                <img src={actor.avatarUrl} alt={actor.name} />
                              ) : actor ? (
                                <span className="issue-list-avatar-initial">
                                  {Array.from(actor.name)[0]}
                                </span>
                              ) : (
                                <SfSymbol name="person.crop.circle" size={20} />
                              )}
                            </span>
                          </span>
                          <time
                            dateTime={task.createdAt}
                            title={`创建于 ${new Date(task.createdAt).toLocaleString("zh-CN")}`}
                          >
                            {createdDate.format(new Date(task.createdAt))}
                          </time>
                        </div>
                      );
                    })
                  ) : (
                    <div className="issue-list-empty">
                      {hasActiveFilters ? "当前筛选下没有匹配任务" : `没有${meta.label}任务`}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
