import type { GlobalLabelView } from "@codexboard/contracts";
import { Tag } from "./icons";
import { useEffect, useRef, useState } from "react";

import { MAX_TASK_LABELS } from "./task-create-model";

export function TaskLabelPicker({
  available,
  catalogReady,
  value,
  disabled,
  onChange,
  variant = "field",
  normalizeSelection = true,
}: {
  readonly available: readonly GlobalLabelView[];
  readonly catalogReady: boolean;
  readonly value: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (labels: string[]) => void;
  readonly variant?: "field" | "pill" | "detail";
  readonly normalizeSelection?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!catalogReady || !normalizeSelection) return;
    const selected = new Set(value);
    const normalized = available
      .filter((label) => selected.has(label.name))
      .map((label) => label.name);
    if (
      normalized.length !== value.length ||
      normalized.some((label, index) => label !== value[index])
    ) {
      onChange(normalized);
    }
  }, [available, catalogReady, normalizeSelection, onChange, value]);

  const text = value.length > 0 ? value.join("；") : "标签";
  return (
    <div
      className={`task-label-picker task-label-picker--${variant}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          rootRef.current?.querySelector("button")?.focus();
        }
      }}
    >
      <button
        className={variant === "pill" ? "task-create-meta-control" : "task-label-picker-trigger"}
        type="button"
        aria-label={`标签：${text}`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Tag aria-hidden="true" data-sf-symbol="tag" />
        {variant === "detail" && value.length > 0 ? (
          <span className="detail-label-chips">
            {value.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </span>
        ) : (
          <span title={text}>{variant === "detail" ? "添加标签…" : text}</span>
        )}
      </button>
      {open ? (
        <div className="task-label-picker-menu" role="group" aria-label="选择标签">
          {available.map((label) => (
            <label key={label.id}>
              <input
                type="checkbox"
                checked={value.includes(label.name)}
                disabled={
                  disabled || (!value.includes(label.name) && value.length >= MAX_TASK_LABELS)
                }
                onChange={(event) =>
                  onChange(
                    available
                      .filter((candidate) => {
                        if (candidate.id === label.id) return event.target.checked;
                        return value.includes(candidate.name);
                      })
                      .map((candidate) => candidate.name),
                  )
                }
              />
              <span>{label.name}</span>
            </label>
          ))}
          {available.length === 0 ? (
            <span className="task-create-empty-option">暂无标签</span>
          ) : null}
          {value.length >= MAX_TASK_LABELS ? (
            <span className="task-create-empty-option">最多选择 20 个标签</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
