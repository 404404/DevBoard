import { taskCardDevelopmentContext } from "./task-card-development-context";
import { useQuery } from "@tanstack/react-query";
import { readTaskCreationOptions, apiRequest } from "./api";
import { z } from "zod";
import { GitBranch } from "./git-branch-icon";
import { TaskProgressSchema, type ProjectKind, type TaskView } from "@lark-taskboard/contracts";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { PriorityIcon } from "./priority-icon";
import { PersonAvatar } from "./person-avatar";
import { priorityLabel } from "./locale";
import { SfSymbol } from "./sf-symbol";
import { TASK_STATUS_META } from "./task-status";
import { taskProjectContext } from "./project-sync";

interface TaskCardPresentationProps {
  readonly task: TaskView;
  readonly projectKind: ProjectKind;
  readonly overlay?: boolean;
  readonly draggable?: boolean;
  readonly dragging?: boolean;
  readonly cardRef?: Ref<HTMLElement>;
  readonly style?: CSSProperties;
  readonly testId?: string;
  readonly onOpen?: () => void;
  readonly articleProps?: Omit<
    ComponentPropsWithoutRef<"article">,
    "aria-hidden" | "children" | "className" | "ref" | "style"
  >;
}

export function TaskCardPresentation({
  task,
  projectKind,
  overlay = false,
  draggable = false,
  dragging = false,
  cardRef,
  style,
  testId,
  onOpen,
  articleProps,
}: TaskCardPresentationProps) {
  const content = (
    <>
      <span className="task-identifier">{task.identifier}</span>
      <strong>{task.title}</strong>
      {task.status === "blocked" ? (
        <span className="task-blocked-badge">
          <SfSymbol name={TASK_STATUS_META.blocked.symbol} size={12} />
          已阻塞
        </span>
      ) : null}
      {taskProjectContext(task, projectKind) ? (
        <span className="task-project-context">{taskProjectContext(task, projectKind)}</span>
      ) : null}
      {task.description ? <p>{task.description}</p> : null}
      <span className="task-card-details">
        <span className="task-card-metadata">
          {task.priority !== "none" && (
            <span className={`priority priority--${task.priority}`}>
              <PriorityIcon priority={task.priority} />
              {priorityLabel(task.priority)}
            </span>
          )}
          {task.assigneeIdentity?.kind === "feishu" && task.assignee && (
            <span
              className="task-card-assignee"
              title={task.assignee.name}
              aria-label={`负责人：${task.assignee.name}`}
            >
              <PersonAvatar person={task.assignee} />
            </span>
          )}
          <TaskCardDevelopmentContext task={task} />
        </span>
        {task.labels.slice(0, 2).map((label) => (
          <span className="task-card-label" key={label}>
            {label}
          </span>
        ))}
        {task.labels.length > 2 && <TaskCardLabelOverflow labels={task.labels.slice(2)} />}
      </span>
      {task.status === "in_progress" && <TaskCardProgress taskId={task.id} />}
    </>
  );
  return (
    <article
      {...articleProps}
      className={[
        "task-card",
        overlay ? "task-drag-overlay" : "",
        draggable ? "task-card--draggable" : "",
        dragging ? "task-card--dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={cardRef}
      style={style}
      data-testid={testId}
      aria-hidden={overlay || undefined}
    >
      {overlay ? (
        <div className="task-open">{content}</div>
      ) : (
        <button className="task-open" type="button" onClick={onOpen}>
          {content}
        </button>
      )}
    </article>
  );
}

function TaskCardDevelopmentContext({ task }: { readonly task: TaskView }) {
  const options = useQuery({
    queryKey: ["task-creation-options", task.projectId],
    queryFn: () => readTaskCreationOptions(task.projectId),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const context = options.data ? taskCardDevelopmentContext(task, options.data) : null;
  const label = context?.branch
    ? context.branch
    : (context?.label ?? (options.isError ? "分支 读取失败" : "正在读取分支…"));
  return (
    <span className="task-card-development" aria-label="分支">
      <span title={label}>
        <GitBranch size={12} />
        <span>{label}</span>
      </span>
    </span>
  );
}

function TaskCardLabelOverflow({ labels }: { readonly labels: readonly string[] }) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  };
  const close = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setPosition(null), 120);
  };
  const open = () => {
    cancelClose();
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    setPosition({
      ...(rect.left > window.innerWidth / 2
        ? {
            right: Math.max(8, window.innerWidth - rect.right),
            maxWidth: Math.min(360, rect.right - 8),
          }
        : {
            left: Math.max(8, rect.left),
            maxWidth: Math.min(360, window.innerWidth - Math.max(8, rect.left) - 8),
          }),
      ...(below >= 160
        ? { top: rect.bottom + 6, maxHeight: below - 14 }
        : { bottom: window.innerHeight - rect.top + 6, maxHeight: rect.top - 14 }),
    });
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!position) return;
    const dismiss = () => setPosition(null);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [position]);
  return (
    <>
      <span
        ref={trigger}
        className="task-card-label"
        tabIndex={0}
        aria-label={`还有 ${labels.length} 个标签`}
        aria-describedby={position ? id : undefined}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        onKeyDown={(event) => {
          if (["Escape", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") setPosition(null);
            else open();
          }
        }}
      >
        +{labels.length}
      </span>
      {position &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className="task-card-label-popover"
            style={position}
            onMouseEnter={cancelClose}
            onMouseLeave={close}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {labels.map((label) => (
              <span className="task-card-label" key={label}>
                {label}
              </span>
            ))}
          </span>,
          document.body,
        )}
    </>
  );
}

function TaskCardProgress({ taskId }: { readonly taskId: string }) {
  const progress = useQuery({
    queryKey: ["task-progress", taskId],
    queryFn: async () =>
      (
        await apiRequest(
          `/api/v1/tasks/${encodeURIComponent(taskId)}/progress`,
          z.object({ data: TaskProgressSchema.nullable() }),
        )
      ).data,
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: false,
  });
  if (progress.isError || !progress.data) return null;
  const { completed, total } = progress.data;
  const label = `处理进度 ${completed}/${total}`;
  return (
    <span
      className="task-card-progress"
      role="progressbar"
      aria-label="处理进度"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-valuetext={label}
      title={label}
    >
      {Array.from({ length: Math.min(total, 100) }, (_, index) => (
        <span
          key={index}
          className={
            index < Math.floor((completed / total) * Math.min(total, 100))
              ? "is-complete"
              : undefined
          }
        />
      ))}
    </span>
  );
}
