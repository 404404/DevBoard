import { describe, expect, it } from "vitest";

import {
  INITIAL_TASK_TOOLBAR_STATE,
  selectedFilterCount,
  taskToolbarReducer,
} from "./task-toolbar-state";

describe("task toolbar state", () => {
  it("opens and closes the compact search affordance", () => {
    const opened = taskToolbarReducer(INITIAL_TASK_TOOLBAR_STATE, { type: "search.open" });
    expect(opened.searchExpanded).toBe(true);
    expect(taskToolbarReducer(opened, { type: "escape" }).searchExpanded).toBe(false);
  });

  it("opens a filter category and closes menus on outside interaction", () => {
    const menu = taskToolbarReducer(INITIAL_TASK_TOOLBAR_STATE, { type: "filter.toggle" });
    const submenu = taskToolbarReducer(menu, { type: "category.open", category: "status" });

    expect(submenu).toMatchObject({ filterOpen: true, activeCategory: "status" });
    expect(taskToolbarReducer(submenu, { type: "outside" })).toEqual(INITIAL_TASK_TOOLBAR_STATE);
  });

  it("counts selected values across status, priority and label filters", () => {
    expect(
      selectedFilterCount({
        query: "ignored",
        statuses: new Set(["todo", "blocked"]),
        priorities: new Set(["urgent"]),
        labels: new Set(["前端", "后端"]),
      }),
    ).toBe(5);
  });
});
