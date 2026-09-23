import { WebLogout } from "./web-login";
import { QueryNotice } from "./query-notice";
import { userErrorMessage } from "./user-error";
import { GitManagerDialog } from "./git-manager-dialog";
import { ExecutionSettingsDialog } from "./execution-settings-dialog";
import { ProjectCreateDialog } from "./project-create-dialog";
import { GitBranch } from "./git-branch-icon";
import { Notice } from "./notification-center";
import { notify } from "./notifications";
import type { JobView } from "@codexboard/contracts";
import { TaskCardPresentation } from "./task-card";
import { createUuid } from "./random-id";
import { readCodexBoardStorage } from "./brand-storage";
/* eslint-disable react-hooks/refs -- dnd-kit exposes callback refs and reactive drag state for DOM binding */
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  InteractionDecision,
  InteractionView,
  ProjectKind,
  ProjectView,
  SessionView,
  TaskView,
} from "@codexboard/contracts";
import { ALL_PROJECT_ID, TEMPORARY_PROJECT_ID } from "@codexboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  FolderKanban,
  LoaderCircle,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  Square,
  TerminalSquare,
  Tags,
} from "./icons";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  ApiError,
  cancelJob,
  listJobInteractions,
  listTaskJobs,
  listProjects,
  moveTask,
  readBoard,
  readDashboard,
  readTaskWorkspace,
  reassignTask,
  respondToInteraction,
  submitTaskJob,
} from "./api";
import { useProjectEvents, visibleRealtimeState } from "./event-feed";
import { isJobActive, isJobCancelable, isJobReconciling, executionNotice } from "./job-status";
import { executionAvailability } from "./execution-availability";
import { jobStatusLabel, useUiCopy } from "./locale";
import { SfSymbol } from "./sf-symbol";
import { ProjectSwitcher } from "./project-switcher";
import {
  canCreateTaskInProject,
  creatableTaskProjects,
  orderProjectViews,
  reassignableProjects,
  visibleProjectKey,
} from "./project-sync";
import { TaskArchiveDrawer, type ArchiveTab } from "./task-archive-drawer";
import { TaskCreateDialog } from "./task-create-dialog";
import { TaskDeleteDialog } from "./task-delete-dialog";
import {
  createTaskMoveCommand,
  dropPositionFromRects,
  planTaskDrop,
  type TaskDropPlan,
} from "./task-drop-model";
import {
  applySettledTaskMove,
  invalidateTaskMoveQueries,
  mergeTaskMove,
  patchOptimisticBoard,
  restoreTaskMoveSnapshot,
  snapshotTaskMoveCaches,
  type TaskMoveCacheSnapshot,
} from "./task-move-cache";
import { TagManagerDialog } from "./tag-manager-dialog";
import { TaskDetail } from "./task-detail";
import { TaskToolbar } from "./task-toolbar";
import {
  ACTIVE_BOARD_STATUSES,
  canDropTaskBetweenStatuses,
  displayColumnForTask,
  groupTasksForWorkspace,
  TASK_STATUS_META,
  type ActiveBoardStatus,
} from "./task-status";
import {
  DashboardPanel,
  EMPTY_FILTERS,
  filterTasks,
  TaskListPanel,
  WorkspaceTabs,
  type TaskFilters,
  type WorkspaceViewMode,
} from "./workspace-views";

const taskBoardCollisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);
  const hitTarget = document
    .elementsFromPoint(args.pointerCoordinates.x, args.pointerCoordinates.y)
    .find(
      (candidate) =>
        !candidate.closest(".task-drag-overlay") && !candidate.querySelector(".task-drag-overlay"),
    );
  return hitTarget?.closest(".kanban") ? pointerWithin(args) : [];
};

function newIdempotencyKey(): string {
  return createUuid();
}

function errorMessage(error: unknown, fallback: string): string {
  return userErrorMessage(error, fallback);
}

function WorkspaceViewContent({
  archive,
  archiveOpen,
  children,
  view,
}: {
  readonly archive: ReactNode;
  readonly archiveOpen: boolean;
  readonly children: ReactNode;
  readonly view: WorkspaceViewMode;
}) {
  return (
    <div
      className={`workspace-view-content workspace-view-content--${view}`}
      data-archive-open={archiveOpen}
    >
      <div className="workspace-view-main">{children}</div>
      {view !== "dashboard" ? archive : null}
    </div>
  );
}

export function BoardPage({
  session,
  onOpenRemote,
}: {
  readonly session: SessionView;
  readonly onOpenRemote?: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState(
    () =>
      new URL(window.location.href).searchParams.get("project") ??
      readCodexBoardStorage(window.localStorage, "selected-project") ??
      "",
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(
    () => new URL(window.location.href).searchParams.get("task") ?? undefined,
  );
  const [taskCreateOpen, setTaskCreateOpen] = useState(false);
  const [taskCreateProject, setTaskCreateProject] = useState<ProjectView>();
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [gitManagerOpen, setGitManagerOpen] = useState(false);
  const [executionSettingsOpen, setExecutionSettingsOpen] = useState(false);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const setNotice = (message?: string) => {
    if (message) notify(message, "error");
  };
  const [view, setView] = useState<WorkspaceViewMode>("board");
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  const [archiveTab, setArchiveTab] = useState<ArchiveTab>("done");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveClosing, setArchiveClosing] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<TaskView>();
  const copy = useUiCopy();
  useEffect(() => {
    document.documentElement.lang = "zh-CN";
    window.localStorage.removeItem("codexboard:locale");
    window.localStorage.removeItem("codexboard:locale");
  }, []);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    select: orderProjectViews,
    refetchInterval: 2_000,
    refetchIntervalInBackground: true,
  });
  const projectSignature = projects.data
    ?.map(
      (project) =>
        `${project.id}:${project.version}:${project.syncState}:${project.rootPaths.join("\u0000")}`,
    )
    .join("\u0001");
  useEffect(() => {
    if (projectSignature === undefined) return;
    void queryClient.invalidateQueries({ queryKey: ["board"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }, [projectSignature, queryClient]);
  const effectiveProjectId =
    projects.data?.some((project) => project.id === selectedProjectId) === true
      ? selectedProjectId
      : projects.data?.[0]?.id;
  const selectedProject = projects.data?.find((project) => project.id === effectiveProjectId);
  const board = useQuery({
    queryKey: ["board", effectiveProjectId],
    queryFn: () => readBoard(effectiveProjectId as string),
    enabled: Boolean(effectiveProjectId),
  });
  const dashboard = useQuery({
    queryKey: ["dashboard", effectiveProjectId],
    queryFn: () => readDashboard(effectiveProjectId as string),
    enabled: Boolean(effectiveProjectId) && view === "dashboard",
  });
  const realtime = useProjectEvents(effectiveProjectId);
  const visibleRealtime = visibleRealtimeState(effectiveProjectId, realtime);
  const taskCreationProjects = creatableTaskProjects(session, projects.data ?? []);
  const canCreateTask = canCreateTaskInProject(session, selectedProject, projects.data ?? []);
  const currentTaskCreateProject = taskCreateProject
    ? projects.data?.find((project) => project.id === taskCreateProject.id)
    : undefined;
  const canSubmitTaskCreation =
    currentTaskCreateProject !== undefined &&
    canCreateTaskInProject(session, currentTaskCreateProject, projects.data ?? []) &&
    realtime !== "offline";
  const selectedProjectKey = visibleProjectKey(selectedProject);
  const hasProjectMetadata =
    Boolean(selectedProjectKey) || (selectedProject?.rootPaths.length ?? 0) > 0;
  const visibleTasks = useMemo(
    () => filterTasks(board.data?.tasks ?? [], filters),
    [board.data?.tasks, filters],
  );
  const activeVisibleTasks = useMemo(
    () => visibleTasks.filter((task) => displayColumnForTask(task) !== null),
    [visibleTasks],
  );

  const selectProject = (projectId: string) => {
    window.localStorage.setItem("codexboard:selected-project", projectId);
    setSelectedProjectId(projectId);
    setSelectedTaskId(undefined);
  };
  return (
    <div className="taskboard-shell">
      <main className="board-workspace">
        <header className="board-header">
          <div className="board-title-block">
            {selectedTaskId ? (
              <span className="detail-project-context">{selectedProject?.name ?? copy.tasks}</span>
            ) : (
              <ProjectSwitcher
                projects={projects.data ?? []}
                selectedProjectId={effectiveProjectId}
                onSelect={selectProject}
              />
            )}
            {hasProjectMetadata ? (
              <div className="board-project-meta">
                <div className="board-heading-row">
                  {selectedProjectKey ? (
                    <span className="project-key">{selectedProjectKey}</span>
                  ) : null}
                </div>
                {selectedProject && selectedProject.rootPaths.length > 0 ? (
                  <p className="project-roots" title={selectedProject.rootPaths.join("\n")}>
                    {selectedProject.rootPaths.join(" · ")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="header-actions">
            <button
              className="button"
              type="button"
              disabled={realtime === "offline"}
              onClick={() => setProjectCreateOpen(true)}
            >
              <Plus aria-hidden="true" />
              <span>新建项目</span>
            </button>
            <button className="button" type="button" onClick={() => setExecutionSettingsOpen(true)}>
              <TerminalSquare aria-hidden="true" />
              <span>执行器</span>
            </button>
            {onOpenRemote && (
              <button className="remote-entry button" onClick={onOpenRemote}>
                <SfSymbol name="apple.terminal" />
                Remote
              </button>
            )}
            {session.actor.identity.kind === "web" && <WebLogout session={session} />}
          </div>
        </header>

        <Notice
          tone="info"
          message={
            visibleRealtime === "offline"
              ? copy.offlineBanner
              : visibleRealtime === "reconnecting"
                ? copy.reconnectingBanner
                : null
          }
        />
        <Notice
          tone="info"
          message={
            selectedProject?.syncState === "stale"
              ? "项目同步离线，当前显示上次成功同步的项目；任务仍可编辑。"
              : null
          }
        />

        {(projects.isError || board.isError || (view === "dashboard" && dashboard.isError)) && (
          <QueryNotice
            error={projects.error ?? board.error ?? dashboard.error}
            fallback="任务暂时无法加载，请重试。"
            refreshing={projects.isFetching || board.isFetching || dashboard.isFetching}
            onRetry={() => {
              if (projects.isError) void projects.refetch();
              if (board.isError) void board.refetch();
              if (dashboard.isError) void dashboard.refetch();
            }}
          />
        )}

        {selectedTaskId ? (
          <TaskDetail
            key={selectedTaskId}
            taskId={selectedTaskId}
            projectKind={selectedProject?.kind ?? "all"}
            onOpenTask={(id) => {
              const url = new URL(window.location.href);
              url.searchParams.set("task", id);
              window.history.replaceState(null, "", url);
              setSelectedTaskId(id);
            }}
            csrfToken={session.csrfToken}
            mutationsEnabled={realtime !== "offline"}
            tasks={board.data?.tasks ?? []}
            actor={session.actor}
            onClose={() => {
              const url = new URL(window.location.href);
              url.searchParams.delete("task");
              url.searchParams.delete("project");
              if (effectiveProjectId)
                window.localStorage.setItem("codexboard:selected-project", effectiveProjectId);
              window.history.replaceState(null, "", url);
              setSelectedTaskId(undefined);
            }}
            renderActions={(task, enabled) => selectedProject?.kind !== "managed" ? (
              <CodexExecutionPanel
                taskId={task.id}
                csrfToken={session.csrfToken}
                executable={enabled && task.permissions.canExecute}
                temporary={task.projectId === TEMPORARY_PROJECT_ID}
                threadState={task.codexThreadState}
              />
            ) : null}
            renderReassign={(task, enabled) =>
              task.permissions.canReassign ? (
                <TaskReassignPanel
                  task={task}
                  projects={projects.data ?? []}
                  csrfToken={session.csrfToken}
                  enabled={enabled}
                  onSaved={() => undefined}
                />
              ) : null
            }
          />
        ) : projects.isPending ? (
          <BoardLoading />
        ) : !projects.data ? null : !selectedProject ? (
          <EmptyProjects onRefresh={() => void projects.refetch()} />
        ) : (
          <>
            <section className="board-command-bar" aria-label={copy.boardCommands}>
              <div>
                <span>{copy.tasks}</span>
                <small>{copy.taskCount(board.data?.tasks.length ?? 0)}</small>
                {selectedProject.kind === "all" ? <small>创建时选择归属项目</small> : null}
                {selectedProject.kind === "temporary" ? (
                  <small>将在 Codex 的最近中创建</small>
                ) : null}
              </div>
              <div className="board-command-actions">
                <button
                  className="button"
                  type="button"
                  disabled={realtime === "offline"}
                  onClick={() => setTagManagerOpen(true)}
                >
                  <Tags aria-hidden="true" />
                  <span className="command-label--full">标签管理</span>
                  <span className="command-label--compact">标签</span>
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={realtime === "offline"}
                  onClick={() => setGitManagerOpen(true)}
                >
                  <GitBranch />
                  <span className="command-label--full">分支 / worktree 管理</span>
                  <span className="command-label--compact">分支</span>
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={!canCreateTask || realtime === "offline"}
                  onClick={() => {
                    if (!taskCreateProject) setTaskCreateProject(selectedProject);
                    setTaskCreateOpen(true);
                  }}
                >
                  <Plus aria-hidden="true" />
                  {copy.newTask}
                </button>
              </div>
            </section>

            <div className="workspace-view-toolbar">
              <WorkspaceTabs
                value={view}
                onChange={(nextView) => {
                  setArchiveClosing(false);
                  setView(nextView);
                }}
              />
              {view !== "dashboard" ? (
                <div className="workspace-view-actions">
                  <TaskToolbar
                    allProjectTasks={board.data?.tasks ?? []}
                    value={filters}
                    onChange={setFilters}
                  />
                  <button
                    type="button"
                    className="icon-button archive-drawer-trigger"
                    aria-label={archiveOpen ? "关闭其他任务" : "打开其他任务"}
                    aria-expanded={archiveOpen}
                    title={archiveOpen ? "关闭其他任务" : "打开其他任务"}
                    onClick={() => {
                      setArchiveClosing(
                        archiveOpen &&
                          !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                      );
                      setArchiveOpen((open) => !open);
                    }}
                  >
                    <SfSymbol name="sidebar.right" />
                  </button>
                </div>
              ) : null}
            </div>

            <WorkspaceViewContent
              archive={
                <TaskArchiveDrawer
                  tab={archiveTab}
                  onTabChange={setArchiveTab}
                  csrfToken={session.csrfToken}
                  mutationsEnabled={realtime !== "offline"}
                  tasks={visibleTasks}
                  open={archiveOpen}
                  onClosed={() => setArchiveClosing(false)}
                  onOpenTask={setSelectedTaskId}
                  onDeleteTask={setDeleteCandidate}
                />
              }
              archiveOpen={archiveOpen || archiveClosing}
              view={view}
            >
              {board.isPending ? (
                <BoardLoading />
              ) : board.data ? (
                view === "dashboard" ? (
                  dashboard.isPending ? (
                    <BoardLoading />
                  ) : dashboard.data ? (
                    <DashboardPanel
                      dashboard={dashboard.data}
                      projectId={selectedProject.id}
                      csrfToken={session.csrfToken}
                      mutationsEnabled={realtime !== "offline"}
                      onOpen={setSelectedTaskId}
                    />
                  ) : null
                ) : view === "board" ? (
                  <TaskBoard
                    tasks={activeVisibleTasks}
                    boardTasks={board.data.tasks}
                    boardProjectId={selectedProject.id}
                    csrfToken={session.csrfToken}
                    projectKind={selectedProject.kind}
                    mutationsEnabled={realtime !== "offline"}
                    onOpen={setSelectedTaskId}
                    onNotice={setNotice}
                  />
                ) : (
                  <TaskListPanel
                    tasks={visibleTasks}
                    csrfToken={session.csrfToken}
                    writable={realtime !== "offline"}
                    actors={[session.actor]}
                    hasActiveFilters={Boolean(
                      filters.query ||
                      filters.statuses.size ||
                      filters.priorities.size ||
                      filters.labels.size,
                    )}
                    projectKind={selectedProject.kind}
                    onOpen={setSelectedTaskId}
                  />
                )
              ) : null}
            </WorkspaceViewContent>
          </>
        )}
      </main>

      {deleteCandidate ? (
        <TaskDeleteDialog
          task={deleteCandidate}
          csrfToken={session.csrfToken}
          onClose={() => setDeleteCandidate(undefined)}
          onDeleted={(task) => {
            if (selectedTaskId === task.id) setSelectedTaskId(undefined);
            setDeleteCandidate(undefined);
            notify(`已永久删除 ${task.identifier}，关联的 Codex 原始任务已归档。`, "success");
          }}
        />
      ) : null}

      {taskCreateProject ? (
        <TaskCreateDialog
          open={taskCreateOpen}
          project={currentTaskCreateProject ?? taskCreateProject}
          projects={taskCreationProjects}
          csrfToken={session.csrfToken}
          mutationsEnabled={canSubmitTaskCreation}
          onClose={() => setTaskCreateOpen(false)}
          onCreated={(task) => {
            setTaskCreateProject(undefined);
            setSelectedTaskId(task.id);
            setNotice(undefined);
          }}
        />
      ) : null}

      {gitManagerOpen ? (
        <GitManagerDialog
          projects={projects.data ?? []}
          initialProjectId={effectiveProjectId}
          csrfToken={session.csrfToken}
          onClose={() => setGitManagerOpen(false)}
        />
      ) : null}
      {tagManagerOpen ? (
        <TagManagerDialog csrfToken={session.csrfToken} onClose={() => setTagManagerOpen(false)} />
      ) : null}
      {executionSettingsOpen ? (
        <ExecutionSettingsDialog
          csrfToken={session.csrfToken}
          onClose={() => setExecutionSettingsOpen(false)}
        />
      ) : null}
      {projectCreateOpen ? (
        <ProjectCreateDialog
          open={projectCreateOpen}
          csrfToken={session.csrfToken}
          onClose={() => setProjectCreateOpen(false)}
          onCreated={(project) => {
            queryClient.setQueryData<readonly ProjectView[]>(["projects"], (current) =>
              current ? [...current.filter((entry) => entry.id !== project.id), project] : [project],
            );
            selectProject(project.id);
            setProjectCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
          }}
        />
      ) : null}
    </div>
  );
}

interface TaskDragState {
  readonly task: TaskView;
  readonly width: number;
}

interface OptimisticTaskMove {
  readonly boardProjectId: string;
  readonly movingTaskId: string;
  readonly tasks: readonly TaskView[];
}

interface TaskMoveMutationVariables {
  readonly boardProjectId: string;
  readonly plan: TaskDropPlan;
  readonly token: number;
  readonly visibleTaskIds: Set<string>;
}

function statusFromOver(over: DragOverEvent["over"]): ActiveBoardStatus | null {
  const status = over?.data.current?.status;
  return ACTIVE_BOARD_STATUSES.includes(status as ActiveBoardStatus)
    ? (status as ActiveBoardStatus)
    : null;
}

function TaskBoard({
  tasks,
  boardTasks,
  boardProjectId,
  csrfToken,
  projectKind,
  mutationsEnabled,
  onOpen,
  onNotice,
}: {
  readonly tasks: readonly TaskView[];
  readonly boardTasks: readonly TaskView[];
  readonly boardProjectId: string;
  readonly csrfToken: string;
  readonly projectKind: ProjectKind;
  readonly mutationsEnabled: boolean;
  readonly onOpen: (taskId: string) => void;
  readonly onNotice: (message: string | undefined) => void;
}) {
  const copy = useUiCopy();
  const queryClient = useQueryClient();
  const [activeDrag, setActiveDrag] = useState<TaskDragState | null>(null);
  const [draggedStatus, setDraggedStatus] = useState<ActiveBoardStatus | null>(null);
  const [overStatus, setOverStatus] = useState<ActiveBoardStatus | null>(null);
  const [optimisticMove, setOptimisticMove] = useState<OptimisticTaskMove | null>(null);
  const moveTokenRef = useRef(0);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const displayedTasks = useMemo(() => {
    if (!optimisticMove || optimisticMove.boardProjectId !== boardProjectId) return tasks;
    const movingTask = optimisticMove.tasks.find(({ id }) => id === optimisticMove.movingTaskId);
    return movingTask ? mergeTaskMove(tasks, optimisticMove.tasks, movingTask) : tasks;
  }, [boardProjectId, optimisticMove, tasks]);
  const taskById = useMemo(
    () => new Map(displayedTasks.map((task) => [task.id, task])),
    [displayedTasks],
  );
  const grouped = useMemo(() => groupTasksForWorkspace(displayedTasks), [displayedTasks]);
  const moveMutation = useMutation({
    mutationFn: ({ boardProjectId: originBoardProjectId, plan }: TaskMoveMutationVariables) =>
      moveTask(
        plan.task.id,
        createTaskMoveCommand(plan, originBoardProjectId),
        csrfToken,
        newIdempotencyKey(),
      ),
    async onMutate({ boardProjectId: originBoardProjectId, plan, token, visibleTaskIds }) {
      if (token !== moveTokenRef.current) return undefined;
      onNotice(undefined);
      setOptimisticMove({
        boardProjectId: originBoardProjectId,
        movingTaskId: plan.task.id,
        tasks: plan.tasks.filter(({ id }) => visibleTaskIds.has(id)),
      });
      const relevantProjectIds = [
        ...new Set([originBoardProjectId, ALL_PROJECT_ID, plan.task.projectId]),
      ];
      await Promise.all(
        relevantProjectIds.map((projectId) =>
          queryClient.cancelQueries({ queryKey: ["board", projectId], exact: true }),
        ),
      );
      const snapshot = snapshotTaskMoveCaches(queryClient, plan.task.id, originBoardProjectId);
      patchOptimisticBoard(queryClient, originBoardProjectId, plan.tasks, plan.task.id);
      return { snapshot } satisfies { readonly snapshot: readonly TaskMoveCacheSnapshot[] };
    },
    async onSuccess(task, { boardProjectId: originBoardProjectId, plan, token, visibleTaskIds }) {
      if (token !== moveTokenRef.current) return;
      const settledTasks = plan.tasks.map((candidate) =>
        candidate.id === task.id ? task : candidate,
      );
      setOptimisticMove({
        boardProjectId: originBoardProjectId,
        movingTaskId: task.id,
        tasks: settledTasks.filter(({ id }) => visibleTaskIds.has(id)),
      });
      applySettledTaskMove(queryClient, originBoardProjectId, plan.tasks, task);
      await invalidateTaskMoveQueries(queryClient, originBoardProjectId, task.projectId);
      if (token === moveTokenRef.current) setOptimisticMove(null);
    },
    onError(error, { boardProjectId: originBoardProjectId, plan, token }, context) {
      if (token !== moveTokenRef.current) return;
      if (context) restoreTaskMoveSnapshot(queryClient, context.snapshot);
      setOptimisticMove(null);
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        onNotice(copy.moveConflict);
      } else {
        onNotice(errorMessage(error, copy.operationFailed));
      }
      void invalidateTaskMoveQueries(queryClient, originBoardProjectId, plan.task.projectId);
    },
  });
  const move = (plan: TaskDropPlan) => {
    if (!mutationsEnabled || !plan.task.permissions.canWrite || moveMutation.isPending) {
      return;
    }
    const token = moveTokenRef.current + 1;
    moveTokenRef.current = token;
    moveMutation.mutate({
      boardProjectId,
      plan,
      token,
      visibleTaskIds: new Set(tasks.map(({ id }) => id)),
    });
  };
  const clearDrag = () => {
    setActiveDrag(null);
    setDraggedStatus(null);
    setOverStatus(null);
  };
  const onDragStart = (event: DragStartEvent) => {
    const task = taskById.get(String(event.active.id));
    const sourceCard = task
      ? document.querySelector<HTMLElement>(`[data-testid="task-card-${task.identifier}"]`)
      : null;
    const width =
      sourceCard?.getBoundingClientRect().width ?? event.active.rect.current.initial?.width ?? 0;
    setActiveDrag(task ? { task, width: width > 0 ? width : 260 } : null);
    setDraggedStatus(task ? displayColumnForTask(task) : null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const task = activeDrag?.task;
    const over = event.over;
    const targetStatus = statusFromOver(over);
    const overTaskId = over?.data.current?.kind === "task" ? String(over.id) : undefined;
    const translatedRect = event.active.rect.current.translated;
    const position =
      overTaskId && translatedRect && over
        ? dropPositionFromRects(translatedRect, over.rect)
        : undefined;
    clearDrag();
    if (!task || !over || !targetStatus) return;
    const plan = planTaskDrop(boardTasks, {
      activeTaskId: task.id,
      targetColumn: targetStatus,
      ...(overTaskId ? { overTaskId } : {}),
      ...(position ? { position } : {}),
    });
    if (plan) move(plan);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={taskBoardCollisionDetection}
      onDragStart={onDragStart}
      onDragOver={(event) => setOverStatus(statusFromOver(event.over))}
      onDragCancel={clearDrag}
      onDragEnd={onDragEnd}
    >
      <section className="kanban" id="board" aria-label={copy.kanban}>
        {ACTIVE_BOARD_STATUSES.map((status) => (
          <StatusColumn
            key={status}
            status={status}
            tasks={grouped.active[status]}
            draggedStatus={draggedStatus}
            overStatus={overStatus}
            projectKind={projectKind}
            mutationsEnabled={mutationsEnabled && !moveMutation.isPending}
            onOpen={onOpen}
          />
        ))}
      </section>
      {createPortal(
        <DragOverlay adjustScale={false}>
          {activeDrag ? (
            <div style={{ "--drag-card-width": `${activeDrag.width}px` } as CSSProperties}>
              <TaskCardPresentation task={activeDrag.task} projectKind={projectKind} overlay />
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

function StatusColumn({
  status,
  tasks,
  draggedStatus,
  overStatus,
  projectKind,
  mutationsEnabled,
  onOpen,
}: {
  readonly status: ActiveBoardStatus;
  readonly tasks: readonly TaskView[];
  readonly draggedStatus: ActiveBoardStatus | null;
  readonly overStatus: ActiveBoardStatus | null;
  readonly projectKind: ProjectKind;
  readonly mutationsEnabled: boolean;
  readonly onOpen: (taskId: string) => void;
}) {
  const copy = useUiCopy();
  const acceptsDraggedTask =
    draggedStatus === null || canDropTaskBetweenStatuses(draggedStatus, status);
  const droppable = useDroppable({
    id: `column:${status}`,
    data: { kind: "column", status },
  });
  const isCurrentTarget = droppable.isOver || overStatus === status;
  const baseClassName = `status-column status-column--${status}`;
  const className = isCurrentTarget
    ? acceptsDraggedTask
      ? `${baseClassName} status-column--over`
      : `${baseClassName} status-column--over-invalid`
    : baseClassName;
  return (
    <section
      className={className}
      ref={droppable.setNodeRef}
      aria-labelledby={`status-${status}`}
      data-testid={`status-column-${status}`}
    >
      <header className="status-header">
        <h2 id={`status-${status}`}>
          <SfSymbol name={TASK_STATUS_META[status].symbol} size={14} />
          {TASK_STATUS_META[status].label}
        </h2>
        <strong>{tasks.length}</strong>
      </header>
      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div className="task-stack">
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              columnStatus={status}
              projectKind={projectKind}
              writable={mutationsEnabled && task.permissions.canWrite}
              onOpen={onOpen}
            />
          ))}
          {tasks.length === 0 ? <p className="empty-column">{copy.noTasks}</p> : null}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableTaskCard({
  task,
  columnStatus,
  projectKind,
  writable,
  onOpen,
}: {
  readonly task: TaskView;
  readonly columnStatus: ActiveBoardStatus;
  readonly projectKind: ProjectKind;
  readonly writable: boolean;
  readonly onOpen: (taskId: string) => void;
}) {
  const sortable = useSortable({
    id: task.id,
    data: { kind: "task", status: columnStatus },
    disabled: {
      draggable: !writable,
      droppable: false,
    },
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <TaskCardPresentation
      task={task}
      projectKind={projectKind}
      draggable={writable}
      dragging={sortable.isDragging}
      cardRef={sortable.setNodeRef}
      style={style}
      testId={`task-card-${task.identifier}`}
      onOpen={() => onOpen(task.id)}
      articleProps={{ ...sortable.attributes, ...sortable.listeners, role: "group" }}
    />
  );
}

function TaskReassignPanel({
  task,
  projects,
  csrfToken,
  enabled,
  onSaved,
}: {
  readonly task: TaskView;
  readonly projects: readonly ProjectView[];
  readonly csrfToken: string;
  readonly enabled: boolean;
  readonly onSaved: (task: TaskView) => void;
}) {
  const copy = useUiCopy();
  const queryClient = useQueryClient();
  const candidates = reassignableProjects(projects);
  const [targetProjectId, setTargetProjectId] = useState(candidates[0]?.id ?? "");
  const [mode, setMode] = useState<"single" | "origin_group">("single");
  const mutation = useMutation({
    mutationFn: () =>
      reassignTask(
        task.id,
        { expectedVersion: task.version, targetProjectId, mode },
        csrfToken,
        newIdempotencyKey(),
      ),
    onSuccess(updated) {
      queryClient.setQueryData(["task", updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["board"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onSaved(updated);
    },
  });

  return (
    <section className="reassign-panel" aria-labelledby="task-reassign-title">
      <header>
        <div>
          <FolderKanban aria-hidden="true" />
          <div>
            <h3 id="task-reassign-title">重新分配到 Codex 项目</h3>
            <p>
              {task.originProjectName
                ? `原项目：${task.originProjectName}`
                : "此任务当前没有可用的 Codex 项目。"}
            </p>
          </div>
        </div>
      </header>
      {candidates.length > 0 ? (
        <div className="reassign-controls">
          <label>
            <span>目标项目</span>
            <select
              aria-label="重新分配目标项目"
              value={targetProjectId}
              disabled={!enabled || mutation.isPending}
              onChange={(event) => setTargetProjectId(event.target.value)}
            >
              {candidates.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>分配范围</span>
            <select
              aria-label="重新分配范围"
              value={mode}
              disabled={!enabled || mutation.isPending}
              onChange={(event) => setMode(event.target.value as "single" | "origin_group")}
            >
              <option value="single">仅此任务</option>
              <option value="origin_group">同一原项目的整组任务</option>
            </select>
          </label>
          <button
            className="button button--primary"
            type="button"
            disabled={!enabled || mutation.isPending || !targetProjectId}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <ArrowRight aria-hidden="true" />
            )}
            确认分配
          </button>
        </div>
      ) : (
        <p className="reassign-empty">暂无可重新分配的项目。请先创建 Project 并配置对应的 SSH Workspace Mapping。</p>
      )}
      {mutation.isError ? (
        <Notice
          message={errorMessage(mutation.error, copy.operationFailed)}
          eventKey={mutation.error}
        />
      ) : null}
    </section>
  );
}

function CodexExecutionPanel({
  taskId,
  csrfToken,
  executable,
  temporary,
  threadState,
}: {
  readonly taskId: string;
  readonly csrfToken: string;
  readonly executable: boolean;
  readonly temporary: boolean;
  readonly threadState: TaskView["codexThreadState"];
}) {
  const copy = useUiCopy();
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: ["jobs", taskId],
    queryFn: () => listTaskJobs(taskId),
    refetchInterval: 2_000,
  });
  const current =
    jobs.data?.find((job) => job.kind !== "cancel" && isJobActive(job.status)) ??
    jobs.data?.find((job) => job.kind !== "cancel");
  const workspace = useQuery({
    queryKey: ["workspace", taskId],
    queryFn: () => readTaskWorkspace(taskId),
    refetchInterval: 2_000,
  });
  const interactions = useQuery({
    queryKey: ["interactions", current?.id],
    queryFn: () => listJobInteractions(current!.id),
    enabled: Boolean(current),
    refetchInterval: 2_000,
  });
  const reconciling = isJobReconciling(current);
  const notice = executionNotice(current);
  const retryCancel =
    current?.status === "canceling" &&
    Boolean(current.errorCode) &&
    !jobs.data?.some((job) => job.kind === "cancel" && isJobActive(job.status));
  const cancelable = current ? isJobCancelable(current.status) || retryCancel : false;
  const hasThread =
    threadState !== "none" || (jobs.data?.some((job) => Boolean(job.taskThreadId)) ?? false);
  const hasStartedTurn = threadState === "started" || Boolean(current);
  const availability = executionAvailability({
    hasStarted: hasStartedTurn,
    reconciling,
    ...(current ? { status: current.status } : {}),
    pendingComments:
      workspace.data?.comments.some(
        (comment) => comment.source === "user" && !comment.executedAt && !comment.deletedAt,
      ) ?? false,
  });
  const submit = useMutation({
    mutationFn: (kind: "start" | "continue") =>
      submitTaskJob(taskId, kind, csrfToken, newIdempotencyKey()),
    onSuccess(job) {
      queryClient.setQueryData<readonly JobView[]>(["jobs", taskId], (previous) => [
        job,
        ...(previous ?? []).filter((entry) => entry.id !== job.id),
      ]);
      void queryClient.invalidateQueries({ queryKey: ["jobs", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["workspace", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelJob(current!.id, csrfToken, newIdempotencyKey()),
    onSuccess(job) {
      queryClient.setQueryData<readonly JobView[]>(["jobs", taskId], (previous) => [
        job,
        ...(previous ?? []).filter((entry) => entry.id !== job.id),
      ]);
      void queryClient.invalidateQueries({ queryKey: ["jobs", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["workspace", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
  const pendingInteraction = interactions.data?.find(
    (interaction) => interaction.status === "pending",
  );

  return (
    <section className="codex-panel" aria-labelledby="codex-execution-title">
      <header className="codex-panel__header">
        <div>
          <TerminalSquare aria-hidden="true" />
          <div>
            <h3 id="codex-execution-title">{copy.codexExecution}</h3>
            <p>{copy.codexDescription}</p>
          </div>
        </div>
        {current ? (
          <span className={`job-status job-status--${current.status}`}>
            {reconciling ? "同步中" : jobStatusLabel(current.status)}
          </span>
        ) : null}
      </header>

      {jobs.isError || workspace.isError || submit.isError || cancel.isError ? (
        <Notice
          message={errorMessage(
            jobs.error ?? workspace.error ?? submit.error ?? cancel.error,
            copy.operationFailed,
          )}
          eventKey={jobs.error ?? workspace.error ?? submit.error ?? cancel.error}
        />
      ) : null}

      {temporary && !hasThread ? (
        <div className="execution-project-prompt" role="status">
          <FolderKanban aria-hidden="true" />
          先重新分配到 Codex 项目，才能启动新的 Codex 任务。
        </div>
      ) : null}

      <div className="codex-actions">
        <button
          className="button button--primary"
          type="button"
          disabled={
            !executable ||
            (temporary && !hasThread) ||
            !availability.canSubmit ||
            submit.isPending ||
            cancel.isPending ||
            jobs.isPending ||
            jobs.isError ||
            workspace.isPending ||
            workspace.isError
          }
          title={availability.reason ?? undefined}
          onClick={() => {
            cancel.reset();
            submit.reset();
            submit.mutate(hasThread ? "continue" : "start");
          }}
        >
          {submit.isPending ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          {hasStartedTurn ? copy.continueCodex : copy.startCodex}
        </button>
        <button
          className="button button--danger"
          type="button"
          disabled={!executable || !cancelable || cancel.isPending || submit.isPending}
          onClick={() => {
            submit.reset();
            cancel.reset();
            cancel.mutate();
          }}
        >
          <Square aria-hidden="true" />
          {reconciling
            ? "取消执行"
            : retryCancel
              ? "重试取消执行"
              : current?.status === "canceling"
                ? "取消中…"
                : copy.cancelExecution}
        </button>
      </div>
      {availability.reason && (
        <p className="execution-availability-hint" role="status">
          {availability.reason}
        </p>
      )}

      {pendingInteraction ? (
        <InteractionCard
          interaction={pendingInteraction}
          csrfToken={csrfToken}
          executable={executable}
          onResolved={() => {
            void interactions.refetch();
            void jobs.refetch();
          }}
        />
      ) : null}

      <Notice
        message={notice?.message ?? null}
        tone={notice?.tone ?? "info"}
        eventKey={current?.id}
      />
    </section>
  );
}

function InteractionCard({
  interaction,
  csrfToken,
  executable,
  onResolved,
}: {
  readonly interaction: InteractionView;
  readonly csrfToken: string;
  readonly executable: boolean;
  readonly onResolved: () => void;
}) {
  const copy = useUiCopy();
  const [answer, setAnswer] = useState("");
  const mutation = useMutation({
    mutationFn: (decision: InteractionDecision) =>
      respondToInteraction(interaction.id, decision, csrfToken, newIdempotencyKey()),
    onSuccess: onResolved,
  });
  const questions = Array.isArray(interaction.safeRequest.questions)
    ? (interaction.safeRequest.questions as Array<Record<string, unknown>>)
    : [];
  const questionId = String(questions[0]?.id ?? "response");
  const title =
    interaction.kind === "command_approval"
      ? copy.commandApproval
      : interaction.kind === "file_change_approval"
        ? copy.fileApproval
        : interaction.kind === "user_input"
          ? copy.codexInput
          : copy.permissionRequest;

  return (
    <div className="interaction-card" role="alert">
      <header>
        <MessageSquareText aria-hidden="true" />
        <strong>{title}</strong>
      </header>
      {typeof interaction.safeRequest.command === "string" ? (
        <code>{interaction.safeRequest.command}</code>
      ) : null}
      {typeof interaction.safeRequest.reason === "string" ? (
        <p>{interaction.safeRequest.reason}</p>
      ) : null}
      {questions.map((question) => (
        <p key={String(question.id)}>
          <strong>{String(question.header ?? copy.question)}</strong>：
          {String(question.question ?? "")}
        </p>
      ))}
      {interaction.kind === "user_input" ? (
        <input
          aria-label={copy.userInput}
          value={answer}
          maxLength={10_000}
          disabled={!executable || mutation.isPending}
          onChange={(event) => setAnswer(event.target.value)}
        />
      ) : null}
      <div className="interaction-actions">
        {interaction.kind === "user_input" ? (
          <button
            className="button button--primary"
            type="button"
            disabled={!executable || !answer.trim() || mutation.isPending}
            onClick={() => mutation.mutate({ type: "input", answers: { [questionId]: [answer] } })}
          >
            {copy.submitInput}
          </button>
        ) : (
          <button
            className="button button--primary"
            type="button"
            disabled={!executable || mutation.isPending}
            onClick={() => mutation.mutate({ type: "accept" })}
          >
            {copy.allowOnce}
          </button>
        )}
        {interaction.kind !== "user_input" ? (
          <button
            className="button"
            type="button"
            disabled={!executable || mutation.isPending}
            onClick={() => mutation.mutate({ type: "decline" })}
          >
            {copy.decline}
          </button>
        ) : null}
        <button
          className="button button--danger"
          type="button"
          disabled={!executable || mutation.isPending}
          onClick={() => mutation.mutate({ type: "cancel" })}
        >
          {copy.cancel}
        </button>
      </div>
      {mutation.isError ? (
        <Notice
          message={errorMessage(mutation.error, copy.operationFailed)}
          eventKey={mutation.error}
        />
      ) : null}
    </div>
  );
}

function EmptyProjects({ onRefresh }: { readonly onRefresh: () => void }) {
  const copy = useUiCopy();
  return (
    <section className="empty-projects">
      <FolderKanban aria-hidden="true" />
      <h2>{copy.noProjects}</h2>
      <p>{copy.noProjectsHint}</p>
      <button className="button" type="button" onClick={onRefresh}>
        <RefreshCw aria-hidden="true" />
        {copy.refreshProjects}
      </button>
    </section>
  );
}

function BoardLoading() {
  const copy = useUiCopy();
  return (
    <section className="board-loading" aria-live="polite">
      <LoaderCircle className="spin" aria-hidden="true" />
      <span>{copy.syncing}</span>
    </section>
  );
}
