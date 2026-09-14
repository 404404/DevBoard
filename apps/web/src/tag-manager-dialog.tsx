import { userErrorMessage } from "./user-error";
import { Notice } from "./notification-center";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { GlobalLabelView } from "@lark-taskboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Plus, Tags, X } from "./icons";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

import {
  createGlobalLabel,
  deleteGlobalLabel,
  listGlobalLabels,
  reorderGlobalLabels,
  updateGlobalLabel,
} from "./api";
import { moveItemToInsertionIndex } from "./task-create-model";
import { labelInsertionIndexAtY } from "./tag-drop-model";

function LabelRow({
  label,
  editing,
  dropBefore,
  dropAfter,
  onEdit,
  onRename,
  onDelete,
}: {
  readonly label: GlobalLabelView;
  readonly editing: boolean;
  readonly dropBefore: boolean;
  readonly dropAfter: boolean;
  readonly onEdit: () => void;
  readonly onRename: (name: string) => void;
  readonly onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: label.id,
  });
  const { setNodeRef: setDropRef } = useDroppable({ id: label.id });
  const [draft, setDraft] = useState(label.name);

  return (
    <li
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      className={`tag-manager-row${isDragging ? " tag-manager-row--dragging" : ""}`}
      data-label-row-id={label.id}
      data-drop-before={dropBefore || undefined}
      data-drop-after={dropAfter || undefined}
    >
      <button
        className="tag-manager-drag-handle"
        type="button"
        aria-label={`拖动标签 ${label.name}`}
        {...listeners}
        {...attributes}
      >
        <GripVertical aria-hidden="true" />
      </button>
      {editing ? (
        <input
          aria-label={`修改标签 ${label.name}`}
          value={draft}
          maxLength={40}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const name = draft.trim();
            if (name && name !== label.name) onRename(name);
            else onEdit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(label.name);
              onEdit();
            }
          }}
        />
      ) : (
        <button className="tag-manager-name" type="button" onClick={onEdit}>
          {label.name}
        </button>
      )}
      <button
        className="tag-manager-delete"
        type="button"
        aria-label={`删除标签 ${label.name}`}
        onClick={onDelete}
      >
        <X aria-hidden="true" />
      </button>
    </li>
  );
}

function LabelDragOverlay({
  label,
  width,
}: {
  readonly label: GlobalLabelView;
  readonly width: number;
}) {
  return (
    <div
      className="tag-manager-drag-overlay"
      style={{ "--tag-drag-width": `${String(width)}px` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="tag-manager-drag-handle">
        <GripVertical aria-hidden="true" />
      </span>
      <span className="tag-manager-name">{label.name}</span>
      <span />
    </div>
  );
}

export function TagManagerDialog({
  csrfToken,
  onClose,
}: {
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<GlobalLabelView>();
  const [activeId, setActiveId] = useState<string>();
  const [activeWidth, setActiveWidth] = useState(0);
  const [dropIndex, setDropIndex] = useState<number>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const labels = useQuery({ queryKey: ["labels"], queryFn: listGlobalLabels });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["labels"] });
    void queryClient.invalidateQueries({ queryKey: ["task-creation-options"] });
    void queryClient.invalidateQueries({ queryKey: ["board"] });
    void queryClient.invalidateQueries({ queryKey: ["task"] });
  };
  const createMutation = useMutation({
    mutationFn: (name: string) => createGlobalLabel(name, csrfToken),
    onSuccess() {
      setDraft("");
      invalidate();
    },
  });
  const renameMutation = useMutation({
    mutationFn: ({ label, name }: { label: GlobalLabelView; name: string }) =>
      updateGlobalLabel(label.id, label.version, name, csrfToken),
    onSuccess() {
      setEditingId(undefined);
      invalidate();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (label: GlobalLabelView) => deleteGlobalLabel(label.id, label.version, csrfToken),
    onSuccess() {
      setDeleteTarget(undefined);
      invalidate();
    },
  });
  const reorderMutation = useMutation({
    mutationFn: (ids: readonly string[]) => reorderGlobalLabels(ids, csrfToken),
    onSuccess(data) {
      queryClient.setQueryData(["labels"], data);
      void queryClient.invalidateQueries({ queryKey: ["task-creation-options"] });
    },
    onError: invalidate,
  });
  const pending =
    createMutation.isPending ||
    renameMutation.isPending ||
    deleteMutation.isPending ||
    reorderMutation.isPending;
  const error =
    createMutation.error ?? renameMutation.error ?? deleteMutation.error ?? reorderMutation.error;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim()) createMutation.mutate(draft.trim());
  };
  const current = labels.data ?? [];
  const activeLabel = current.find((label) => label.id === activeId);
  const clearDrag = () => {
    setActiveId(undefined);
    setActiveWidth(0);
    setDropIndex(undefined);
  };
  const dragMove = (event: DragMoveEvent) => {
    const activeRect = event.active.rect.current.translated;
    const dialog = dialogRef.current;
    if (!activeRect || !dialog) return;
    const list = dialog.querySelector<HTMLElement>(".tag-manager-list");
    if (!list) return;
    const listRect = list.getBoundingClientRect();
    const rows = [...dialog.querySelectorAll<HTMLElement>("[data-label-row-id]")].map((row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    setDropIndex(
      labelInsertionIndexAtY(rows, activeRect.top + activeRect.height / 2, {
        top: listRect.top,
        height: listRect.height,
      }),
    );
  };
  const finishDrag = (event: DragEndEvent) => {
    const insertionIndex = dropIndex;
    clearDrag();
    if (insertionIndex !== undefined) {
      const reordered = moveItemToInsertionIndex(
        current.map((label) => label.id),
        String(event.active.id),
        insertionIndex,
      );
      if (reordered.some((id, index) => id !== current[index]?.id))
        reorderMutation.mutate(reordered);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="tag-manager-backdrop"
      aria-labelledby="tag-manager-title"
      onCancel={(event) => {
        event.preventDefault();
        if (activeId) return;
        if (!pending) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section className="tag-manager-dialog">
        <header>
          <div>
            <Tags aria-hidden="true" data-sf-symbol="tag" />
            <h2 id="tag-manager-title">标签管理</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭标签管理"
            onClick={onClose}
            disabled={pending}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <form className="tag-manager-add" onSubmit={submit}>
          <input
            aria-label="新标签名称"
            placeholder="输入标签名称"
            value={draft}
            maxLength={40}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={!draft.trim() || pending}>
            <Plus aria-hidden="true" />
            新增
          </button>
        </form>
        {error ? (
          <Notice message={userErrorMessage(error, "标签操作失败")} eventKey={error} />
        ) : null}
        {labels.isPending ? <p className="tag-manager-empty">正在加载标签…</p> : null}
        <DndContext
          sensors={sensors}
          onDragStart={(event: DragStartEvent) => {
            const id = String(event.active.id);
            const row = dialogRef.current?.querySelector<HTMLElement>(
              `[data-label-row-id="${id}"]`,
            );
            setActiveId(id);
            setActiveWidth(row?.getBoundingClientRect().width ?? 0);
            setDropIndex(current.findIndex((label) => label.id === id));
          }}
          onDragMove={dragMove}
          onDragEnd={finishDrag}
          onDragCancel={clearDrag}
        >
          <ul className="tag-manager-list" aria-label="全局标签排序">
            {current.map((label, index) => (
              <LabelRow
                key={`${label.id}:${label.version}`}
                label={label}
                editing={editingId === label.id}
                dropBefore={Boolean(activeId) && dropIndex === index}
                dropAfter={
                  Boolean(activeId) && dropIndex === current.length && index === current.length - 1
                }
                onEdit={() => setEditingId((id) => (id === label.id ? undefined : label.id))}
                onRename={(name) => renameMutation.mutate({ label, name })}
                onDelete={() => setDeleteTarget(label)}
              />
            ))}
          </ul>
          <DragOverlay adjustScale={false} dropAnimation={null}>
            {activeLabel ? (
              <LabelDragOverlay label={activeLabel} width={activeWidth || 300} />
            ) : null}
          </DragOverlay>
        </DndContext>
        {!labels.isPending && current.length === 0 ? (
          <p className="tag-manager-empty">暂无标签</p>
        ) : null}
      </section>
      {deleteTarget ? (
        <div className="tag-delete-confirm-layer" role="presentation">
          <section role="alertdialog" aria-modal="true" aria-labelledby="tag-delete-title">
            <h3 id="tag-delete-title">删除“{deleteTarget.name}”？</h3>
            <p>该标签会从所有项目的已有任务中同步移除，此操作不可撤销。</p>
            <div>
              <button
                type="button"
                onClick={() => setDeleteTarget(undefined)}
                disabled={deleteMutation.isPending}
              >
                取消
              </button>
              <button
                className="button--danger"
                type="button"
                onClick={() => deleteMutation.mutate(deleteTarget)}
                disabled={deleteMutation.isPending}
              >
                删除标签
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </dialog>
  );
}
