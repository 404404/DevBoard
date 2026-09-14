import type { TaskPriority, TaskStatus, TaskView } from "@lark-taskboard/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer, useRef } from "react";

import { listGlobalLabels } from "./api";
import { SfSymbol } from "./sf-symbol";
import { PriorityIcon } from "./priority-icon";
import { availableFilterOptions, EMPTY_TASK_FILTERS, type TaskFilters } from "./task-filters";
import {
  INITIAL_TASK_TOOLBAR_STATE,
  selectedFilterCount,
  taskToolbarReducer,
  type FilterCategory,
} from "./task-toolbar-state";
import { FILTERABLE_TASK_STATUSES, TASK_STATUS_META } from "./task-status";

const PRIORITY_ORDER = ["urgent", "high", "medium", "low", "none"] as const;
const PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};
const CATEGORY_LABELS: Readonly<Record<FilterCategory, string>> = {
  status: "状态",
  priority: "优先级",
  label: "标签",
};

export function TaskToolbar({
  allProjectTasks,
  value,
  onChange,
}: {
  readonly allProjectTasks: readonly TaskView[];
  readonly value: TaskFilters;
  readonly onChange: (value: TaskFilters) => void;
}) {
  const [state, dispatch] = useReducer(taskToolbarReducer, INITIAL_TASK_TOOLBAR_STATE);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const available = useMemo(() => availableFilterOptions(allProjectTasks), [allProjectTasks]);
  const globalLabels = useQuery({ queryKey: ["labels"], queryFn: listGlobalLabels });
  const selectedCount = selectedFilterCount(value);
  const labels = useMemo(
    () =>
      [
        ...new Set([
          ...(globalLabels.data ?? []).map((label) => label.name),
          ...available.labels,
          ...value.labels,
        ]),
      ].sort((a, b) => a.localeCompare(b)),
    [available.labels, globalLabels.data, value.labels],
  );

  useEffect(() => {
    if (state.searchExpanded) searchRef.current?.focus();
  }, [state.searchExpanded]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (event.key === "/" && !isEditable) {
        event.preventDefault();
        dispatch({ type: "search.open" });
      } else if (event.key === "Escape" && (state.searchExpanded || state.filterOpen)) {
        event.preventDefault();
        if (state.searchExpanded && value.query) onChange({ ...value, query: "" });
        dispatch({ type: "escape" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onChange, state.filterOpen, state.searchExpanded, value]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dispatch({ type: "outside" });
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const toggleStatus = (status: TaskStatus) =>
    onChange({ ...value, statuses: toggled(value.statuses, status) });
  const togglePriority = (priority: TaskPriority) =>
    onChange({ ...value, priorities: toggled(value.priorities, priority) });
  const toggleLabel = (label: string) =>
    onChange({ ...value, labels: toggled(value.labels, label) });

  return (
    <div className="task-toolbar" ref={rootRef} aria-label="搜索和筛选任务">
      <div className={state.searchExpanded ? "task-search task-search--expanded" : "task-search"}>
        <button
          type="button"
          className="icon-button"
          aria-label="搜索任务"
          aria-expanded={state.searchExpanded}
          title="搜索任务（/）"
          onClick={() => dispatch({ type: "search.open" })}
        >
          <SfSymbol name="magnifyingglass" />
        </button>
        {state.searchExpanded ? (
          <>
            <input
              ref={searchRef}
              type="search"
              aria-label="搜索任务"
              placeholder="搜索任务…"
              value={value.query}
              onChange={(event) => onChange({ ...value, query: event.target.value })}
            />
            <button
              type="button"
              className="icon-button task-search__close"
              aria-label="清除并收起搜索"
              title="清除并收起搜索"
              onClick={() => {
                onChange({ ...value, query: "" });
                dispatch({ type: "escape" });
              }}
            >
              <SfSymbol name="xmark" size={12} />
            </button>
          </>
        ) : null}
      </div>

      <div className="task-filter-menu-wrap">
        <button
          type="button"
          className="icon-button task-filter-trigger"
          aria-label="筛选任务"
          aria-expanded={state.filterOpen}
          aria-controls="task-filter-menu"
          title="筛选任务"
          onClick={() => dispatch({ type: "filter.toggle" })}
        >
          <SfSymbol name="line.3.horizontal.decrease" />
          {selectedCount > 0 ? <span className="filter-count">{selectedCount}</span> : null}
        </button>

        {state.filterOpen ? (
          <div
            className="task-filter-menu"
            id="task-filter-menu"
            role="menu"
            aria-label="筛选任务菜单"
          >
            <div className="task-filter-menu__root">
              {(Object.keys(CATEGORY_LABELS) as FilterCategory[]).map((category) => (
                <button
                  key={category}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={state.activeCategory === category}
                  data-filter-category={category}
                  onPointerEnter={() => dispatch({ type: "category.open", category })}
                  onFocus={() => dispatch({ type: "category.open", category })}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      dispatch({ type: "category.open", category });
                      requestAnimationFrame(() => {
                        rootRef.current
                          ?.querySelector<HTMLElement>(
                            `.task-filter-submenu[aria-label="按${CATEGORY_LABELS[category]}筛选"] [role="menuitemcheckbox"]:not([disabled])`,
                          )
                          ?.focus();
                      });
                    }
                  }}
                >
                  <SfSymbol name="chevron.left" size={12} />
                  <span className="task-filter-category-label">{CATEGORY_LABELS[category]}</span>
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                disabled={selectedCount === 0}
                onClick={() => onChange({ ...EMPTY_TASK_FILTERS, query: value.query })}
              >
                清除筛选
              </button>
            </div>

            {state.activeCategory === "status" ? (
              <FilterSubmenu category="status" label="按状态筛选">
                {FILTERABLE_TASK_STATUSES.map((status) => (
                  <FilterOption
                    key={status}
                    category="status"
                    label={TASK_STATUS_META[status].label}
                    checked={value.statuses.has(status)}
                    available={available.statuses.has(status)}
                    onToggle={() => toggleStatus(status)}
                    icon={
                      <SfSymbol
                        name={TASK_STATUS_META[status].symbol}
                        className={`task-filter-status-icon--${status}`}
                      />
                    }
                  />
                ))}
              </FilterSubmenu>
            ) : state.activeCategory === "priority" ? (
              <FilterSubmenu category="priority" label="按优先级筛选">
                {PRIORITY_ORDER.map((priority) => (
                  <FilterOption
                    key={priority}
                    category="priority"
                    label={PRIORITY_LABELS[priority]}
                    checked={value.priorities.has(priority)}
                    available={available.priorities.has(priority)}
                    onToggle={() => togglePriority(priority)}
                    icon={
                      <PriorityIcon priority={priority} className="task-filter-priority-icon" />
                    }
                  />
                ))}
              </FilterSubmenu>
            ) : state.activeCategory === "label" ? (
              <FilterSubmenu category="label" label="按标签筛选">
                {labels.length ? (
                  labels.map((label) => (
                    <FilterOption
                      key={label}
                      category="label"
                      label={label}
                      checked={value.labels.has(label)}
                      available={available.labels.has(label)}
                      onToggle={() => toggleLabel(label)}
                    />
                  ))
                ) : (
                  <span className="task-filter-menu__empty">当前项目暂无标签</span>
                )}
              </FilterSubmenu>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilterSubmenu({
  category,
  label,
  children,
}: {
  readonly category: FilterCategory;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className="task-filter-submenu"
      role="menu"
      aria-label={label}
      data-filter-category={category}
    >
      {children}
    </div>
  );
}

function FilterOption({
  available,
  category,
  checked,
  icon,
  label,
  onToggle,
}: {
  readonly available: boolean;
  readonly category: FilterCategory;
  readonly checked: boolean;
  readonly icon?: React.ReactNode;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-disabled={!available}
      disabled={!available}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          (
            event.currentTarget
              .closest(".task-filter-menu")
              ?.querySelector(
                `.task-filter-menu__root [data-filter-category="${category}"]`,
              ) as HTMLButtonElement | null
          )?.focus();
        }
      }}
      onClick={onToggle}
    >
      {icon}
      <span>{label}</span>
      {checked ? <SfSymbol name="checkmark" size={12} /> : null}
    </button>
  );
}

function toggled<T>(values: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
