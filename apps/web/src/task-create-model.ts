import type { TaskPriority } from "@lark-taskboard/contracts";

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface DialogRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface DialogBounds {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
}

export interface AttachmentFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface RejectedAttachment<FileLike extends AttachmentFileLike> {
  readonly file: FileLike;
  readonly reason: string;
}

export type TaskRelationKind = "parent" | "child" | "related";

export interface RelationSelection {
  readonly parentTaskId?: string;
  readonly childTaskIds?: readonly string[];
  readonly relatedTaskIds: readonly string[];
}

interface TaskRelationCandidateLike {
  readonly identifier: string;
  readonly title: string;
}

export const MAX_TASK_LABELS = 20;

export function isCompactTaskDialogViewport(viewport: {
  readonly width: number;
  readonly height: number;
}): boolean {
  return viewport.width <= 720 || viewport.height <= 560;
}

export function attachmentFileExtension(name: string): string {
  const separator = name.lastIndexOf(".");
  if (separator <= 0 || separator === name.length - 1) return "FILE";
  const extension = name.slice(separator + 1).replace(/[^a-z0-9]/gi, "");
  return extension ? extension.slice(0, 5).toUpperCase() : "FILE";
}

export function selectedLabelNamesInCatalogOrder<Label extends { id: string; name: string }>(
  catalog: readonly Label[],
  selectedIds: readonly string[],
): string[] {
  const selected = new Set(selectedIds);
  return catalog.filter((label) => selected.has(label.id)).map((label) => label.name);
}

export function toggleSelectedLabelId(
  current: readonly string[],
  labelId: string,
  maximum = MAX_TASK_LABELS,
): string[] {
  if (current.includes(labelId)) return current.filter((id) => id !== labelId);
  if (current.length >= maximum) return [...current];
  return [...current, labelId];
}

export function filterTaskRelationCandidates<Candidate extends TaskRelationCandidateLike>(
  candidates: readonly Candidate[],
  search: string,
): Candidate[] {
  const normalized = search.trim().toLocaleLowerCase();
  if (!normalized) return [...candidates];
  return candidates.filter(
    (candidate) =>
      candidate.identifier.toLocaleLowerCase().includes(normalized) ||
      candidate.title.toLocaleLowerCase().includes(normalized),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function fitDialogRectToContent(
  baseline: DialogRect,
  requiredHeight: number,
  bounds: DialogBounds,
): DialogRect {
  const maximumHeight = bounds.height - bounds.padding * 2;
  const height = clamp(Math.max(baseline.height, requiredHeight), baseline.height, maximumHeight);
  const top = clamp(baseline.top, bounds.padding, bounds.height - bounds.padding - height);
  return { ...baseline, top, height };
}

export function relationCandidateState(
  kind: TaskRelationKind,
  candidateId: string,
  selection: RelationSelection,
): { readonly selected: boolean; readonly disabled: boolean } {
  const { parentTaskId, childTaskIds = [], relatedTaskIds } = selection;

  if (kind === "parent") {
    const selected = parentTaskId === candidateId;
    return {
      selected,
      disabled:
        !selected &&
        (Boolean(parentTaskId) ||
          childTaskIds.includes(candidateId) ||
          relatedTaskIds.includes(candidateId)),
    };
  }

  if (kind === "child") {
    const selected = childTaskIds.includes(candidateId);
    return {
      selected,
      disabled: !selected && (parentTaskId === candidateId || relatedTaskIds.includes(candidateId)),
    };
  }

  const selected = relatedTaskIds.includes(candidateId);
  return {
    selected,
    disabled: !selected && (parentTaskId === candidateId || childTaskIds.includes(candidateId)),
  };
}

export function resizeDialogRect(
  start: DialogRect,
  edge: ResizeEdge,
  deltaX: number,
  deltaY: number,
  bounds: DialogBounds,
): DialogRect {
  const minWidth = bounds.minWidth ?? 560;
  const minHeight = bounds.minHeight ?? 300;
  let left = start.left;
  let top = start.top;
  let right = start.left + start.width;
  let bottom = start.top + start.height;

  if (edge.includes("w")) {
    left = clamp(start.left + deltaX, bounds.padding, right - minWidth);
  }
  if (edge.includes("e")) {
    right = clamp(
      start.left + start.width + deltaX,
      left + minWidth,
      bounds.width - bounds.padding,
    );
  }
  if (edge.includes("n")) {
    top = clamp(start.top + deltaY, bounds.padding, bottom - minHeight);
  }
  if (edge.includes("s")) {
    bottom = clamp(
      start.top + start.height + deltaY,
      top + minHeight,
      bounds.height - bounds.padding,
    );
  }

  return { left, top, width: right - left, height: bottom - top };
}

export function maximizeDialogRect(
  bounds: Omit<DialogBounds, "minWidth" | "minHeight">,
): DialogRect {
  return {
    left: bounds.padding,
    top: bounds.padding,
    width: bounds.width - bounds.padding * 2,
    height: bounds.height - bounds.padding * 2,
  };
}

export function appendAttachmentFiles<FileLike extends AttachmentFileLike>(
  current: readonly FileLike[],
  selected: readonly FileLike[],
  maxBytes: number,
): {
  readonly accepted: FileLike[];
  readonly rejected: Array<RejectedAttachment<FileLike>>;
} {
  const accepted = [...current];
  const rejected: Array<RejectedAttachment<FileLike>> = [];
  for (const file of selected) {
    if (file.size > maxBytes) {
      rejected.push({ file, reason: `文件超过 ${formatBytes(maxBytes)} 上限` });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

export function moveItemToInsertionIndex<Item>(
  items: readonly Item[],
  active: Item,
  insertionIndex: number,
): Item[] {
  const currentIndex = items.indexOf(active);
  if (currentIndex < 0) return [...items];
  const remaining = items.filter((_, index) => index !== currentIndex);
  const adjustedIndex = clamp(
    insertionIndex - (currentIndex < insertionIndex ? 1 : 0),
    0,
    remaining.length,
  );
  return [...remaining.slice(0, adjustedIndex), active, ...remaining.slice(adjustedIndex)];
}

export function priorityBarStates(priority: TaskPriority): readonly [boolean, boolean, boolean] {
  if (priority === "high") return [true, true, true];
  if (priority === "medium") return [true, true, false];
  if (priority === "low") return [true, false, false];
  return [false, false, false];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
