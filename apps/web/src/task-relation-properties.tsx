import { userErrorMessage } from "./user-error";
import { Notice } from "./notification-center";
import type { ProjectKind, TaskRelationView, TaskView } from "@lark-taskboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import {
  createRelation,
  deleteRelation,
  readTask,
  readTaskCreationOptions,
  readTaskWorkspace,
} from "./api";
import { TaskCardPresentation } from "./task-card";
import { Search } from "./icons";
import { SfSymbol } from "./sf-symbol";
import { filterTaskRelationCandidates } from "./task-create-model";

type RelationType = TaskRelationView["relationType"];
const labels: Record<RelationType, string> = {
  parent: "父任务",
  child: "子任务",
  related: "关联任务",
  blocks: "阻塞",
  blocked_by: "被阻塞",
};

export function TaskRelationProperties({
  task,
  csrfToken,
  writable,
  onOpenTask,
  projectKind,
}: {
  readonly task: TaskView;
  readonly csrfToken: string;
  readonly writable: boolean;
  readonly onOpenTask: (id: string) => void;
  readonly projectKind: ProjectKind;
}) {
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace", task.id],
    queryFn: () => readTaskWorkspace(task.id),
    refetchInterval: 5_000,
  });
  const options = useQuery({
    queryKey: ["task-creation-options", task.projectId],
    queryFn: () => readTaskCreationOptions(task.projectId),
    enabled: writable,
    staleTime: 0,
    refetchInterval: 5_000,
  });
  const [open, setOpen] = useState<RelationType | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["workspace"] });
    void client.invalidateQueries({ queryKey: ["dashboard", task.projectId] });
    void client.invalidateQueries({ queryKey: ["task-creation-options", task.projectId] });
  };
  const create = useMutation({
    mutationFn: ({ type, targetId }: { type: RelationType; targetId: string }) =>
      createRelation(task.id, type, targetId, csrfToken),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRelation(task.id, id, csrfToken),
    onSuccess: refresh,
  });
  useEffect(() => {
    if (!open && !preview) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(null);
        setPreview(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, preview]);
  const relations = workspace.data?.relations ?? [];
  const types: RelationType[] = ["parent", "child", "related"];
  for (const type of ["blocks", "blocked_by"] as const) {
    if (relations.some((relation) => relation.relationType === type)) types.push(type);
  }
  const candidates = filterTaskRelationCandidates(
    (options.data?.relationCandidates ?? []).filter((candidate) => candidate.id !== task.id),
    search,
  );
  const busy = create.isPending || remove.isPending;
  return (
    <div
      className="detail-relation-properties"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(null);
          setPreview(null);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          root.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
          setOpen(null);
          setPreview(null);
        }
      }}
    >
      {types.map((type) => {
        const selected = relations.filter((relation) => relation.relationType === type);
        const singleFilled = type === "parent" && selected.length > 0;
        return (
          <div className="detail-property-row detail-relation-row" key={type}>
            <span>{labels[type]}</span>
            <div className="detail-relation-value">
              {selected.map((relation) => (
                <div className="detail-relation-item" key={relation.id}>
                  <button
                    type="button"
                    className="detail-relation-preview-trigger"
                    title={`${relation.targetIdentifier} ${relation.targetTitle}`}
                    aria-label={`预览任务 ${relation.targetIdentifier}`}
                    aria-expanded={preview === relation.id}
                    aria-haspopup="dialog"
                    onClick={() => {
                      setOpen(null);
                      setPreview(preview === relation.id ? null : relation.id);
                    }}
                  >
                    <small>{relation.targetIdentifier}</small>
                    <span>{relation.targetTitle}</span>
                  </button>
                  {preview === relation.id && (
                    <RelationTaskPreview
                      relation={relation}
                      onOpenTask={onOpenTask}
                      projectKind={projectKind}
                    />
                  )}
                  {writable && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除${labels[type]} ${relation.targetIdentifier}`}
                      disabled={busy}
                      onClick={() => remove.mutate(relation.id)}
                    >
                      <SfSymbol name="xmark" size={12} />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="detail-property-trigger"
                aria-label={`添加${labels[type]}`}
                aria-haspopup="menu"
                aria-expanded={open === type}
                aria-controls={open === type ? menuId : undefined}
                disabled={!writable || busy || !workspace.data}
                onClick={() => {
                  setPreview(null);
                  setSearch("");
                  setOpen(open === type ? null : type);
                }}
              >
                <SfSymbol name="plus" size={14} />
                <span>添加{labels[type]}</span>
                <SfSymbol name="chevron.right" size={12} />
              </button>
              {open === type && writable && (
                <div
                  className="task-create-relation-submenu detail-relation-menu"
                  id={menuId}
                  role="menu"
                  aria-label={`${labels[type]}候选`}
                >
                  <label className="task-create-relation-search">
                    <Search aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="搜索任务"
                      placeholder="搜索任务"
                      value={search}
                      autoFocus
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  {singleFilled && (
                    <span className="task-create-empty-option">请先移除已有{labels[type]}</span>
                  )}
                  {candidates.map((candidate) => {
                    const linked = relations.some(
                      (relation) => relation.targetTaskId === candidate.id,
                    );
                    const current = selected.some(
                      (relation) => relation.targetTaskId === candidate.id,
                    );
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        key={candidate.id}
                        aria-label={`${candidate.identifier} ${candidate.title}`}
                        data-selected={current || undefined}
                        disabled={busy || linked || singleFilled}
                        onClick={() => {
                          create.mutate({ type, targetId: candidate.id });
                          setOpen(null);
                        }}
                      >
                        <span>{candidate.identifier}</span>
                        <small>{candidate.title}</small>
                      </button>
                    );
                  })}
                  {options.isPending && (
                    <span className="task-create-empty-option">正在加载任务…</span>
                  )}
                  {options.isError && (
                    <Notice message="任务加载失败，请稍后重试" eventKey={options.error} />
                  )}
                  {options.isSuccess && candidates.length === 0 && (
                    <span className="task-create-empty-option">暂无可绑定任务</span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {(workspace.isError || create.isError || remove.isError) && (
        <Notice
          message={userErrorMessage(
            create.error ?? remove.error ?? workspace.error,
            "任务关系操作失败，请重试。",
          )}
          eventKey={create.error ?? remove.error ?? workspace.error}
        />
      )}
    </div>
  );
}

function RelationTaskPreview({
  relation,
  onOpenTask,
  projectKind,
}: {
  readonly relation: TaskRelationView;
  readonly onOpenTask: (id: string) => void;
  readonly projectKind: ProjectKind;
}) {
  const target = useQuery({
    queryKey: ["task", relation.targetTaskId],
    queryFn: () => readTask(relation.targetTaskId),
    staleTime: 0,
  });
  return (
    <div
      className="detail-relation-preview"
      role="dialog"
      aria-label={`任务卡片 ${relation.targetIdentifier}`}
    >
      {target.isPending && <p role="status">正在加载任务…</p>}
      {target.isError ? (
        <>
          <p role="alert">任务暂时无法读取，请重试。</p>
          <button type="button" onClick={() => void target.refetch()}>
            重试
          </button>
        </>
      ) : (
        target.data && (
          <TaskCardPresentation
            task={target.data}
            projectKind={projectKind}
            onOpen={() => onOpenTask(relation.targetTaskId)}
          />
        )
      )}
    </div>
  );
}
