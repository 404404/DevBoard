import { QueryNotice } from "./query-notice";
import { userErrorMessage } from "./user-error";
import { TaskBranchProperty } from "./task-branch-property";
import { Notice } from "./notification-center";
import { notify } from "./notifications";
import type { ProjectKind, SessionView, TaskView } from "@codexboard/contracts";
import { ALL_PROJECT_ID } from "@codexboard/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ApiError,
  listGlobalLabels,
  moveTask,
  readTask,
  readTaskCreationOptions,
  updateTask,
  readTaskLifecycle,
} from "./api";
import {
  TaskAutosave,
  EDITABLE_TASK_FIELDS,
  type EditableTaskField,
  type TaskDraftPatch,
} from "./task-autosave";
import { applyTaskUpdate, invalidateTaskMoveQueries } from "./task-move-cache";
import { priorityLabel, statusLabel } from "./locale";
import { MarkdownContent } from "./markdown";
import { SfSymbol } from "./sf-symbol";
import { copyText } from "./copy-text";
import { createUuid } from "./random-id";
import { canSelectTaskStatus, TASK_STATUS_META, TASK_STATUS_ORDER } from "./task-status";
import { TaskLabelPicker } from "./task-label-picker";
import { PriorityIcon } from "./priority-icon";
import { DetailPropertyPicker } from "./detail-property-picker";
import { TaskRelationProperties } from "./task-relation-properties";
import { PersonAvatar } from "./person-avatar";
import { TaskDescriptionAttachments, TaskWorkspacePanel } from "./task-workspace";
import { TaskLifecycleActions } from "./task-lifecycle-actions";

interface DetailProps {
  readonly taskId: string;
  readonly projectKind: ProjectKind;
  readonly csrfToken: string;
  readonly mutationsEnabled: boolean;
  readonly tasks: readonly TaskView[];
  readonly actor: SessionView["actor"];
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly renderActions: (task: TaskView, enabled: boolean) => ReactNode;
  readonly renderReassign: (task: TaskView, enabled: boolean) => ReactNode;
}

export function TaskDetail(props: DetailProps) {
  const query = useQuery({
    queryKey: ["task", props.taskId],
    queryFn: () => readTask(props.taskId),
    refetchInterval: 2_000,
  });
  if (!query.data)
    return (
      <section className="task-detail-page" aria-label="任务详情">
        <header className="task-detail-topbar">
          <button className="detail-back-button" type="button" onClick={props.onClose}>
            返回看板
          </button>
        </header>
        <div
          className={query.isError ? undefined : "detail-query-state"}
          role={query.isError ? undefined : "status"}
        >
          {query.isError ? (
            <QueryNotice
              error={query.error}
              fallback="任务暂时无法加载，请重试。"
              refreshing={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          ) : (
            "正在加载任务…"
          )}
        </div>
      </section>
    );
  return (
    <TaskDetailEditor
      key={`${props.taskId}:${query.data.status === "done" || query.data.status === "canceled"}`}
      {...props}
      task={query.data}
    />
  );
}

function TaskDetailEditor({ task, ...props }: DetailProps & { readonly task: TaskView }) {
  const queryClient = useQueryClient();
  const [save] = useState(
    () =>
      new TaskAutosave(task, async (current, patch) => {
        const { status, ...fields } = patch;
        const updated =
          status !== undefined
            ? await moveTask(
                current.id,
                { expectedVersion: current.version, targetStatus: status },
                props.csrfToken,
                createUuid(),
              )
            : await updateTask(
                current.id,
                {
                  expectedVersion: current.version,
                  ...fields,
                  ...(fields.labels ? { labels: [...fields.labels] } : {}),
                  ...(fields.links ? { links: [...fields.links] } : {}),
                },
                props.csrfToken,
                createUuid(),
              );
        await queryClient.cancelQueries({ queryKey: ["task", current.id], exact: true });
        applyTaskUpdate(queryClient, updated);
        void queryClient.invalidateQueries({ queryKey: ["workspace", current.id] });
        void invalidateTaskMoveQueries(queryClient, ALL_PROJECT_ID, updated.projectId);
        return updated;
      }),
  );
  const state = useSyncExternalStore(save.subscribe, save.getSnapshot, save.getSnapshot);
  const lifecycle = useQuery({
    queryKey: ["lifecycle", task.id],
    queryFn: () => readTaskLifecycle(task.id),
    refetchInterval: 2_000,
  });
  const lifecycleHeld =
    lifecycle.data?.status === "pending" ||
    lifecycle.data?.status === "running" ||
    lifecycle.data?.status === "failed";
  const terminal = task.status === "done" || task.status === "canceled";
  const writable =
    props.mutationsEnabled && task.permissions.canWrite && !lifecycleHeld && !terminal;
  const descriptionWritable = writable && !task.descriptionLocked;
  const [commentDrafts, setCommentDrafts] = useState<Record<string, boolean>>({});
  const onCommentDraftChange = useCallback((key: string, dirty: boolean) => {
    setCommentDrafts((previous) =>
      Boolean(previous[key]) === dirty ? previous : { ...previous, [key]: dirty },
    );
  }, []);
  const hasCommentDrafts = Object.values(commentDrafts).some(Boolean);
  const [editingDescription, setEditingDescription] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const labels = useQuery({ queryKey: ["labels"], queryFn: listGlobalLabels });
  const creationOptions = useQuery({
    queryKey: ["task-creation-options", state.task.projectId],
    queryFn: () => readTaskCreationOptions(state.task.projectId),
    enabled: task.permissions.canRead,
    refetchInterval: 5_000,
  });
  const branchLabel = state.draft.developmentContextId
    ? (creationOptions.data?.developmentContexts.find(
        (context) => context.id === state.draft.developmentContextId,
      )?.label ?? (creationOptions.isPending ? "加载中…" : "分支不可用"))
    : (creationOptions.data?.defaultDevelopmentContext.label ?? "无");
  const branchWritable =
    writable &&
    !state.task.archivedAt &&
    task.developmentContextLocked === false &&
    state.task.developmentContextLocked === false &&
    creationOptions.isSuccess;
  const branchOptions = [
    { value: "", label: creationOptions.data?.defaultDevelopmentContext.label ?? "无" },
    ...(creationOptions.data?.developmentContexts ?? []).map((context) => ({
      value: context.id,
      label: context.label,
    })),
  ];
  const conflict = state.error instanceof ApiError && state.error.code === "VERSION_CONFLICT";

  useEffect(() => save.receive(task), [save, task]);
  useEffect(() => {
    if (task.descriptionLocked) save.cancel("description");
  }, [save, task.descriptionLocked]);
  useEffect(() => {
    if (task.developmentContextLocked) save.cancel("developmentContextId");
  }, [save, task.developmentContextLocked]);
  useEffect(() => {
    save.setEnabled(writable);
    return () => save.setEnabled(false);
  }, [save, writable]);
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const resize = () => {
      title.style.height = "auto";
      title.style.height = `${title.scrollHeight}px`;
    };
    resize();
    let width = title.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (title.clientWidth === width) return;
      width = title.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(title);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [state.draft.title]);
  useEffect(() => {
    if (!state.dirty && !state.pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.dirty, state.pending]);

  const changeProperty = (field: EditableTaskField, patch: TaskDraftPatch) => {
    if (!writable) return;
    save.edit(patch);
    save.commit(field);
  };
  const close = async (onLeave = props.onClose) => {
    if (terminal) {
      onLeave();
      return;
    }
    if (writable)
      for (const field of EDITABLE_TASK_FIELDS) {
        if (field !== "description" || descriptionWritable) save.commit(field);
      }
    setLeaving(true);
    await save.flush();
    setLeaving(false);
    if (save.getSnapshot().dirty || save.getSnapshot().pending || save.getSnapshot().error) return;
    onLeave();
  };
  const reload = async () => {
    setReloadError("");
    try {
      const latest = await readTask(task.id);
      save.reset(latest);
      applyTaskUpdate(queryClient, latest);
      setEditingDescription(false);
    } catch (error) {
      setReloadError(userErrorMessage(error, "重新加载失败，请重试。"));
    }
  };
  const copy = async (value: string) => {
    const result = await copyText(value);
    if (result.copied) {
      notify("已复制", "success");
    } else {
      notify(result.guidance, "error");
    }
  };

  return (
    <section className="task-detail-page" aria-label="任务详情">
      <header className="task-detail-topbar">
        <button
          className="detail-back-button"
          type="button"
          aria-label="返回看板"
          autoFocus
          disabled={leaving}
          onClick={() => void close()}
        >
          <SfSymbol name="chevron.left" size={14} />
          <span>返回看板</span>
        </button>
        <div className="detail-id-control">
          <button
            type="button"
            className="detail-breadcrumb"
            disabled={terminal}
            title="点击复制任务 ID"
            aria-label={`复制任务 ID ${state.task.identifier}`}
            onClick={() => void copy(state.task.identifier)}
          >
            <span>{state.task.identifier}</span>
            <svg
              className="detail-copy-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="12" height="13" rx="2" />
              <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
        <span className="detail-save-state" role="status">
          {!writable
            ? "只读"
            : state.pending
              ? "正在保存…"
              : state.error
                ? "未保存"
                : state.dirty
                  ? "编辑中"
                  : "已自动保存"}
        </span>
      </header>
      <fieldset
        className="task-detail-scroll"
        disabled={terminal}
        onClickCapture={
          terminal
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
              }
            : undefined
        }
        onKeyDownCapture={
          terminal
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }
            : undefined
        }
      >
        {reloadError && <Notice message={reloadError} />}
        {state.error && (
          <div className="detail-save-recovery">
            <Notice
              message={
                conflict
                  ? "任务已被其他人更新，草稿已保留。请复制需要保留的内容，再加载最新版本。"
                  : userErrorMessage(state.error, "保存失败，草稿已保留，请重试。")
              }
              eventKey={state.error}
            />
            {conflict ? (
              <button type="button" onClick={() => void reload()}>
                放弃草稿并加载最新版本
              </button>
            ) : (
              <button
                type="button"
                disabled={!writable}
                onClick={() => {
                  void save.retry();
                }}
              >
                重试保存
              </button>
            )}
          </div>
        )}
        <div className="task-detail-layout">
          <div className="task-detail-main">
            <article className="detail-content-editor" aria-label="任务内容">
              <textarea
                ref={titleRef}
                className="detail-title-input"
                aria-label="标题"
                rows={1}
                maxLength={500}
                value={state.draft.title}
                disabled={!writable}
                onChange={(event) => save.edit({ title: event.target.value.replace(/\n/g, "") })}
                onBlur={() => {
                  if (writable) save.commit("title");
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    save.cancel("title");
                    event.currentTarget.blur();
                  }
                }}
              />
              <TaskDescriptionAttachments
                taskId={state.task.id}
                csrfToken={props.csrfToken}
                writable={descriptionWritable}
                editing={editingDescription && descriptionWritable}
                onEditingEnd={() => {
                  if (descriptionWritable) save.commit("description");
                  setEditingDescription(false);
                }}
                onDraftChange={onCommentDraftChange}
              >
                {(attachmentControl) => (
                  <>
                    {editingDescription && descriptionWritable ? (
                      <div className="detail-description-editor">
                        <textarea
                          aria-label="描述"
                          autoFocus
                          value={state.draft.description}
                          rows={8}
                          maxLength={100_000}
                          disabled={!descriptionWritable}
                          placeholder="添加描述…"
                          onChange={(event) => save.edit({ description: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === "Escape") {
                              event.preventDefault();
                              save.cancel("description");
                              setEditingDescription(false);
                            }
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                          }}
                        />
                        {attachmentControl}
                        <small>支持 Markdown · 离开编辑区自动保存 · Esc 取消</small>
                      </div>
                    ) : (
                      <div
                        className="detail-description-read"
                        role={descriptionWritable ? "button" : undefined}
                        tabIndex={descriptionWritable ? 0 : undefined}
                        aria-label={descriptionWritable ? "编辑描述" : "描述"}
                        onClick={(event) => {
                          if (descriptionWritable && !(event.target as HTMLElement).closest("a"))
                            setEditingDescription(true);
                        }}
                        onKeyDown={(event) => {
                          if (
                            descriptionWritable &&
                            event.target === event.currentTarget &&
                            (event.key === "Enter" || event.key === " ")
                          ) {
                            event.preventDefault();
                            setEditingDescription(true);
                          }
                        }}
                      >
                        {state.draft.description.trim() ? (
                          <MarkdownContent markdown={state.draft.description} />
                        ) : (
                          <span className="detail-placeholder">添加描述…</span>
                        )}
                      </div>
                    )}
                    {task.descriptionLocked && !terminal && (
                      <p className="detail-description-hint">
                        任务描述已锁定，后续修改请通过评论补充。
                      </p>
                    )}
                  </>
                )}
              </TaskDescriptionAttachments>
            </article>
            <TaskWorkspacePanel
              task={state.task}
              actor={props.actor}
              csrfToken={props.csrfToken}
              writable={writable}
              onDraftChange={onCommentDraftChange}
            />
          </div>
          <aside className="task-detail-properties" aria-label="任务属性">
            <div className="detail-execution-actions">
              {state.task.status !== "backlog" &&
                props.renderActions(
                  state.task,
                  !terminal &&
                    props.mutationsEnabled &&
                    !lifecycleHeld &&
                    !state.pending &&
                    !state.dirty,
                )}
              {hasCommentDrafts && <p className="muted">请先保存或放弃评论草稿，再操作任务。</p>}
              <TaskLifecycleActions
                task={state.task}
                csrfToken={props.csrfToken}
                enabled={
                  !terminal &&
                  props.mutationsEnabled &&
                  task.permissions.canWrite &&
                  !hasCommentDrafts &&
                  !state.pending &&
                  !state.dirty &&
                  !state.error &&
                  !lifecycle.isPending &&
                  !lifecycle.isError
                }
                onAccepted={props.onClose}
                onInitiate={() => changeProperty("status", { status: "todo" })}
                initiateEnabled={writable && !lifecycle.isPending && !lifecycle.isError}
                operation={lifecycle.data}
              />
            </div>
            <h2>属性</h2>
            <div className="detail-property-row">
              <span>状态</span>
              <DetailPropertyPicker
                label="状态"
                value={state.draft.status}
                disabled={!writable}
                options={TASK_STATUS_ORDER.map((status) => ({
                  value: status,
                  label: statusLabel(status),
                  icon: (
                    <span style={{ color: `var(--task-status-${status})` }}>
                      <SfSymbol name={TASK_STATUS_META[status].symbol} size={14} />
                    </span>
                  ),
                  disabled:
                    (status === "done" && hasCommentDrafts) ||
                    !canSelectTaskStatus({ ...state.task, status: state.draft.status }, status),
                }))}
                onChange={(status) => changeProperty("status", { status })}
              />
            </div>
            <div className="detail-property-row">
              <span>优先级</span>
              <DetailPropertyPicker
                label="优先级"
                value={state.draft.priority}
                disabled={!writable}
                options={(["none", "urgent", "high", "medium", "low"] as const).map((priority) => ({
                  value: priority,
                  label: priorityLabel(priority),
                  icon: <PriorityIcon priority={priority} />,
                }))}
                onChange={(priority) => changeProperty("priority", { priority })}
              />
            </div>
            <div className="detail-property-row">
              <span>负责人</span>
              <div className="detail-assignee" aria-label="负责人">
                {state.task.assignee && <PersonAvatar person={state.task.assignee} />}
                <span className="detail-property-text" title={state.task.assignee?.name}>
                  {state.task.assignee?.name ?? "负责人信息暂不可用"}
                </span>
              </div>
            </div>
            {creationOptions.isError && (
              <>
                <Notice message="项目配置加载失败。" eventKey={creationOptions.error} />
                <button type="button" onClick={() => void creationOptions.refetch()}>
                  重试
                </button>
              </>
            )}
            <div className="detail-property-row">
              <span>标签</span>
              <TaskLabelPicker
                variant="detail"
                available={labels.data ?? []}
                catalogReady={labels.isSuccess}
                value={state.draft.labels}
                disabled={!writable}
                normalizeSelection={false}
                onChange={(value) => changeProperty("labels", { labels: value })}
              />
            </div>
            <TaskRelationProperties
              key={state.task.id}
              projectKind={props.projectKind}
              onOpenTask={(id) => {
                if (hasCommentDrafts) {
                  notify("请先保存或放弃评论草稿，再打开其他任务。", "error");
                  return;
                }
                void close(() => props.onOpenTask(id));
              }}
              task={state.task}
              csrfToken={props.csrfToken}
              writable={writable}
            />
            <TaskBranchProperty
              value={state.draft.developmentContextId ?? ""}
              label={branchLabel}
              writable={branchWritable}
              options={branchOptions}
              onChange={(value) =>
                changeProperty("developmentContextId", { developmentContextId: value || null })
              }
            />
            <div className="detail-property-row">
              <span>项目</span>
              <span className="detail-property-text" title={state.task.projectName}>
                {state.task.projectName}
              </span>
            </div>
            {state.task.workingDirectory && (
              <div className="detail-property-row detail-directory">
                <span>工作目录</span>
                <span title={state.task.workingDirectory}>{state.task.workingDirectory}</span>
              </div>
            )}
            {state.draft.links.length > 0 && (
              <section className="detail-links-section" aria-label="任务链接">
                <h2>链接</h2>
                {state.draft.links.map((link) => (
                  <a href={link} target="_blank" rel="noopener noreferrer" key={link}>
                    <SfSymbol name="arrow.up.right.square" size={14} />
                    <span>{link}</span>
                  </a>
                ))}
              </section>
            )}
            {props.renderReassign(
              state.task,
              !terminal && props.mutationsEnabled && !state.pending && !state.dirty,
            )}
            <div className="detail-timestamps">
              <span>创建于 {new Date(state.task.createdAt).toLocaleString("zh-CN")}</span>
              <span>更新于 {new Date(state.task.updatedAt).toLocaleString("zh-CN")}</span>
            </div>
          </aside>
        </div>
      </fieldset>
    </section>
  );
}
