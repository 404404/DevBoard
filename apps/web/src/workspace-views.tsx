/* eslint-disable react-refresh/only-export-components -- filter primitives are colocated with the three shared task views */
import type { DashboardView, TaskPriority } from "@codexboard/contracts";
import { EMPTY_TASK_FILTERS, filterTasks, type TaskFilters } from "./task-filters";

export type WorkspaceViewMode = "dashboard" | "board" | "list";

export { filterTasks };
export { TaskListPanel } from "./task-list";
export type { TaskFilters };
export const EMPTY_FILTERS = EMPTY_TASK_FILTERS;

const PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const VIEW_LABELS: Readonly<Record<WorkspaceViewMode, string>> = {
  dashboard: "仪表盘",
  board: "看板",
  list: "列表",
};
export function WorkspaceTabs({
  value,
  onChange,
}: {
  readonly value: WorkspaceViewMode;
  readonly onChange: (value: WorkspaceViewMode) => void;
}) {
  return (
    <nav className="workspace-tabs" aria-label="项目视图">
      {(Object.keys(VIEW_LABELS) as WorkspaceViewMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          role="tab"
          aria-selected={mode === value}
          onClick={() => onChange(mode)}
        >
          {VIEW_LABELS[mode]}
        </button>
      ))}
    </nav>
  );
}

export function DashboardPanel({
  dashboard,
  onOpen,
}: {
  readonly dashboard: DashboardView;
  readonly onOpen: (id: string) => void;
}) {
  return (
    <section className="dashboard-panel" aria-label="项目仪表盘">
      <div className="metric-grid">
        <Metric label="任务总数" value={dashboard.totalTasks} />
        <Metric label="完成率" value={`${dashboard.completionPercent}%`} />
        <Metric label="阻塞或未读" value={dashboard.blockedOrUnreadCount} />
        <Metric label="运行中对话" value={dashboard.runningConversationCount} />
      </div>
      <section className="priority-distribution" aria-label="优先级分布">
        <h2>优先级分布</h2>
        <div>
          {(Object.keys(dashboard.priorityCounts) as TaskPriority[]).map((priority) => (
            <article key={priority}>
              <span>{PRIORITY_LABELS[priority]}</span>
              <strong>{dashboard.priorityCounts[priority]}</strong>
            </article>
          ))}
        </div>
      </section>
      <div className="dashboard-lists">
        <DashboardList
          title="阻塞或未读"
          empty="暂无任务"
          tasks={dashboard.blockedOrUnreadTasks}
          onOpen={onOpen}
        />
        <DashboardList
          title="即将到期"
          empty="暂无任务"
          tasks={dashboard.dueSoonTasks}
          onOpen={onOpen}
        />
      </div>
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function DashboardList({
  title,
  empty,
  tasks,
  onOpen,
}: {
  readonly title: string;
  readonly empty: string;
  readonly tasks: DashboardView["dueSoonTasks"];
  readonly onOpen: (id: string) => void;
}) {
  return (
    <section className="dashboard-list">
      <h2>{title}</h2>
      {tasks.length === 0 ? (
        <p>{empty}</p>
      ) : (
        tasks.map((task) => (
          <button type="button" key={task.id} onClick={() => onOpen(task.id)}>
            <span>{task.identifier}</span>
            <strong>{task.title}</strong>
          </button>
        ))
      )}
    </section>
  );
}
