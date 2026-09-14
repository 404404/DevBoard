import type { ProjectView } from "@lark-codex/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectSwitcher } from "./project-switcher";
import { filterProjectOptions, projectSymbolForKind } from "./project-switcher-options";

describe("ProjectSwitcher", () => {
  it("maps the three project kinds to their approved symbols", () => {
    expect(projectSymbolForKind("all")).toBe("square.3.layers.3d");
    expect(projectSymbolForKind("temporary")).toBe("clock");
    expect(projectSymbolForKind("codex")).toBe("folder");
  });

  it("filters projects by name without mutating their order", () => {
    const projects = [
      { id: "all", name: "全部项目", kind: "all" },
      { id: "temp", name: "临时项目", kind: "temporary" },
      { id: "code", name: "测试项目", kind: "codex" },
    ] as ProjectView[];
    expect(filterProjectOptions(projects, "测试").map((project) => project.id)).toEqual(["code"]);
    expect(projects.map((project) => project.id)).toEqual(["all", "temp", "code"]);
  });

  it("renders a text-only trigger with the current project name", () => {
    const project = { id: "all", name: "全部项目", kind: "all" } as ProjectView;
    const html = renderToStaticMarkup(
      createElement(ProjectSwitcher, {
        projects: [project],
        selectedProjectId: project.id,
        onSelect: () => undefined,
      }),
    );
    expect(html).toContain("全部项目");
    expect(html).not.toContain('data-project-trigger-icon="true"');
  });
});
