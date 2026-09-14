import type { TaskFilters } from "./task-filters";

export type FilterCategory = "status" | "priority" | "label";

export interface TaskToolbarState {
  readonly activeCategory: FilterCategory | null;
  readonly filterOpen: boolean;
  readonly searchExpanded: boolean;
}

export type TaskToolbarAction =
  | { readonly type: "search.open" }
  | { readonly type: "filter.toggle" }
  | { readonly type: "category.open"; readonly category: FilterCategory }
  | { readonly type: "escape" | "outside" };

export const INITIAL_TASK_TOOLBAR_STATE: TaskToolbarState = {
  activeCategory: null,
  filterOpen: false,
  searchExpanded: false,
};

export function taskToolbarReducer(
  state: TaskToolbarState,
  action: TaskToolbarAction,
): TaskToolbarState {
  switch (action.type) {
    case "search.open":
      return { ...state, filterOpen: false, activeCategory: null, searchExpanded: true };
    case "filter.toggle":
      return {
        ...state,
        filterOpen: !state.filterOpen,
        activeCategory: null,
      };
    case "category.open":
      return { ...state, filterOpen: true, activeCategory: action.category };
    case "escape":
    case "outside":
      return INITIAL_TASK_TOOLBAR_STATE;
  }
}

export function selectedFilterCount(filters: TaskFilters): number {
  return filters.statuses.size + filters.priorities.size + filters.labels.size;
}
