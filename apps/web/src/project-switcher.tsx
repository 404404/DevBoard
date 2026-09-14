import type { ProjectView } from "@lark-codex/contracts";
import { useEffect, useRef, useState } from "react";

import { SfSymbol } from "./sf-symbol";
import { filterProjectOptions, projectSymbolForKind } from "./project-switcher-options";

interface ProjectSwitcherProps {
  readonly projects: readonly ProjectView[];
  readonly selectedProjectId: string | undefined;
  readonly onSelect: (projectId: string) => void;
}

export function ProjectSwitcher({ projects, selectedProjectId, onSelect }: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = projects.find((project) => project.id === selectedProjectId);
  const options = filterProjectOptions(projects, query);

  useEffect(() => {
    if (!open) return;
    const closeWhenClickingOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeWhenClickingOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeWhenClickingOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const selectProject = (projectId: string) => {
    setQuery("");
    setOpen(false);
    onSelect(projectId);
    triggerRef.current?.focus();
  };

  return (
    <div className="project-switcher" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`切换项目，当前：${selected?.name ?? "全部项目"}`}
        className="project-switcher__trigger"
        ref={triggerRef}
        title={selected?.name ?? "全部项目"}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.name ?? "全部项目"}</span>
        <i aria-hidden="true" className="project-switcher__chevron" />
      </button>
      {open ? (
        <div aria-label="切换项目" className="project-switcher__menu" role="menu">
          <h2 className="project-switcher__heading">切换项目</h2>
          <div className="project-switcher__search">
            <SfSymbol aria-hidden="true" name="magnifyingglass" size={14} />
            <input
              aria-label="筛选项目"
              autoFocus
              placeholder="筛选项目"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="project-switcher__options">
            {options.map((project) => {
              const current = project.id === selectedProjectId;
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className="project-switcher__option"
                  key={project.id}
                  role="menuitem"
                  type="button"
                  onClick={() => selectProject(project.id)}
                >
                  <SfSymbol
                    aria-hidden="true"
                    name={projectSymbolForKind(project.kind)}
                    size={14}
                  />
                  <span>{project.name}</span>
                  {current ? <SfSymbol aria-hidden="true" name="checkmark" size={12} /> : null}
                </button>
              );
            })}
            {options.length === 0 ? (
              <p className="project-switcher__empty">未找到匹配项目</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
