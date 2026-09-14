import { QueryNotice } from "./query-notice";
import { Notice } from "./notification-center";
import { userErrorMessage } from "./user-error";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateGitResourceCommand,
  GitEntry,
  GitCreationOrigin,
  ProjectView,
} from "@lark-codex/contracts";
import { createGitResource, deleteGitResource, readGitManagement } from "./api";
import { GitBranch } from "./git-branch-icon";
import { Plus, X } from "./icons";

export function GitManagerDialog({
  projects,
  initialProjectId,
  csrfToken,
  onClose,
}: {
  readonly projects: readonly ProjectView[];
  readonly initialProjectId?: string | undefined;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const available = projects.filter(
    (project) => project.kind === "codex" && project.syncState === "synced" && !project.archivedAt,
  );
  const [selected, setSelected] = useState(
    available.find((project) => project.id === initialProjectId)?.id ?? available[0]?.id ?? "",
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tag-manager-backdrop git-manager-backdrop"
      aria-labelledby="git-manager-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="tag-manager-dialog git-manager-dialog">
        <header>
          <div>
            <GitBranch />
            <h2 id="git-manager-title">分支 / worktree 管理</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭分支管理"
            disabled={busy}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <div className="git-manager-project">
          <label htmlFor="git-project">项目</label>
          <select
            id="git-project"
            value={selected}
            disabled={busy}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!available.length ? <option value="">暂无可用项目</option> : null}
            {available.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        {selected && available.some((project) => project.id === selected) ? (
          <GitProjectManager
            key={selected}
            projectId={selected}
            csrfToken={csrfToken}
            onBusy={setBusy}
          />
        ) : (
          <p className="git-manager-empty">请先在 Codex 中添加本地 Git 项目。</p>
        )}
      </section>
    </dialog>
  );
}

function GitProjectManager({
  projectId,
  csrfToken,
  onBusy,
}: {
  readonly projectId: string;
  readonly csrfToken: string;
  readonly onBusy: (busy: boolean) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["git-management", projectId],
    queryFn: () => readGitManagement(projectId),
    refetchInterval: 10_000,
    retry: false,
  });
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<"branch" | "worktree">("worktree");
  const [existing, setExisting] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [directory, setDirectory] = useState("");
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<GitEntry>();
  const [success, setSuccess] = useState("");
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["git-management", projectId] }),
      client.invalidateQueries({ queryKey: ["task-creation-options", projectId] }),
    ]);
  };
  const create = useMutation({
    mutationFn: (command: CreateGitResourceCommand) =>
      createGitResource(projectId, command, csrfToken),
    onSuccess: async () => {
      setFormOpen(false);
      setBranch("");
      setDirectory("");
      setSuccess(kind === "worktree" ? "已创建，可在任务中选择新的工作树" : "分支已创建");
      await invalidate();
    },
    onError: invalidate,
  });
  const remove = useMutation({
    mutationFn: (entry: GitEntry) =>
      deleteGitResource(
        projectId,
        { branch: entry.branch, path: entry.path, expectedHead: entry.headSha },
        csrfToken,
      ),
    onSuccess: async () => {
      setTarget(undefined);
      setSuccess("已删除");
      await invalidate();
    },
    onError: invalidate,
  });
  const pending = create.isPending || remove.isPending;
  useEffect(() => {
    onBusy(pending);
    return () => onBusy(false);
  }, [pending, onBusy]);
  const branches = [
    ...new Set(query.data?.entries.flatMap((entry) => (entry.branch ? [entry.branch] : [])) ?? []),
  ];
  const freeBranches = branches.filter(
    (name) => !query.data?.entries.some((entry) => entry.branch === name && entry.path),
  );
  const baseBranch = base || query.data?.defaultBranch || branches[0] || "";
  const error = create.error ?? remove.error;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSuccess("");
    remove.reset();
    create.mutate(
      kind === "branch"
        ? { kind, branch: branch.trim(), baseBranch }
        : {
            kind,
            branch: branch.trim(),
            baseBranch,
            directoryName: directory.trim(),
            existingBranch: existing,
          },
    );
  };
  return (
    <>
      <div className="git-manager-toolbar">
        <input
          aria-label="搜索分支或路径"
          placeholder="搜索分支或路径"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          className="button"
          type="button"
          disabled={pending || query.isFetching}
          onClick={() => {
            setSuccess("");
            void query.refetch();
          }}
        >
          {query.isFetching ? "刷新中…" : "刷新"}
        </button>
        <button
          className="button"
          type="button"
          disabled={pending || !query.data || query.isError}
          onClick={() => {
            create.reset();
            remove.reset();
            setTarget(undefined);
            setFormOpen(!formOpen);
          }}
        >
          <Plus />
          新建
        </button>
      </div>
      {query.isPending ? <p className="git-manager-empty">正在读取 Git 仓库…</p> : null}
      {query.isError ? (
        <QueryNotice
          error={query.error}
          fallback="仓库暂时无法加载，请重试。"
          refreshing={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {error ? <Notice message={userErrorMessage(error)} eventKey={error} /> : null}
      {success ? (
        <p className="git-manager-message" role="status">
          {success}
        </p>
      ) : null}
      {formOpen && query.data ? (
        <form className="git-manager-form" onSubmit={submit}>
          <div className="git-manager-fields">
            <label>
              创建类型
              <select
                value={kind}
                disabled={pending}
                onChange={(event) => {
                  setKind(event.target.value as "branch" | "worktree");
                  setExisting(false);
                  setBranch("");
                }}
              >
                <option value="worktree">独立 worktree</option>
                <option value="branch">仅创建分支</option>
              </select>
            </label>
            {kind === "worktree" ? (
              <label>
                分支来源
                <select
                  value={existing ? "existing" : "new"}
                  disabled={pending}
                  onChange={(event) => {
                    setExisting(event.target.value === "existing");
                    setBranch("");
                  }}
                >
                  <option value="new">新建分支</option>
                  <option value="existing">使用已有分支</option>
                </select>
              </label>
            ) : null}
            <label>
              {existing ? "已有分支" : "分支名称"}
              {existing ? (
                <select
                  value={branch}
                  disabled={pending}
                  required
                  onChange={(event) => setBranch(event.target.value)}
                >
                  <option value="">选择未被工作树使用的分支</option>
                  {freeBranches.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={branch}
                  disabled={pending}
                  placeholder="feature/my-change"
                  maxLength={200}
                  required
                  onChange={(event) => setBranch(event.target.value)}
                />
              )}
            </label>
            {!existing ? (
              <label>
                起始分支
                <select
                  value={baseBranch}
                  disabled={pending}
                  required
                  onChange={(event) => setBase(event.target.value)}
                >
                  {branches.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {kind === "worktree" ? (
              <label>
                目录名称
                <input
                  value={directory}
                  disabled={pending}
                  placeholder="my-change"
                  maxLength={80}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  title="小写字母、数字和连字符"
                  required
                  onChange={(event) => setDirectory(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <p>
            {kind === "worktree"
              ? `保存到 ${query.data.mainPath}/.worktrees/${directory || "目录名称"}`
              : "仅创建 Git 分支。创建独立 worktree 后才可作为任务工作目录。"}
          </p>
          <div className="git-manager-form-actions">
            <button
              className="button"
              type="button"
              disabled={pending}
              onClick={() => setFormOpen(false)}
            >
              取消
            </button>
            <button
              className="button button--primary"
              disabled={pending || !branch.trim() || (!existing && !baseBranch)}
            >
              {create.isPending ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      ) : null}
      {target ? (
        <section
          className="git-manager-confirm"
          role="alertdialog"
          aria-labelledby="git-delete-title"
        >
          <h3 id="git-delete-title">删除 {target.branch ?? "分离的 worktree"}？</h3>
          <p>
            {target.path
              ? `将移除目录 ${target.path}${target.branch ? "，并删除对应分支" : ""}。`
              : "将删除这个本地分支。"}
            删除前会再次检查提交、文件和任务占用。
          </p>
          <div className="git-manager-form-actions">
            <button
              className="button"
              disabled={pending}
              type="button"
              onClick={() => {
                setTarget(undefined);
                remove.reset();
              }}
            >
              取消
            </button>
            <button
              className="button button--danger"
              type="button"
              disabled={pending}
              onClick={() => {
                create.reset();
                setSuccess("");
                remove.mutate(target);
              }}
            >
              {remove.isPending ? "删除中…" : "确认删除"}
            </button>
          </div>
        </section>
      ) : null}
      {query.data ? (
        <>
          <p className="git-manager-summary">
            {branches.length} 个分支 · {query.data.entries.filter((entry) => entry.path).length}{" "}
            个工作树 <span>主分支：{query.data.defaultBranch ?? "未设置"}</span>
          </p>
          <ul className="git-manager-list" aria-label="分支和工作树">
            {query.data.entries
              .filter((entry) =>
                `${entry.branch ?? "分离 HEAD"} ${entry.path ?? ""}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((entry) => (
                <li key={entry.path ?? entry.branch}>
                  <div className="git-manager-entry">
                    <div className="git-manager-entry-title">
                      <GitBranch />
                      <strong>{entry.branch ?? "分离 HEAD"}</strong>
                      {entry.isMain ? (
                        <span>主工作树</span>
                      ) : entry.isCurrent ? (
                        <span>项目目录</span>
                      ) : null}
                      {entry.dirty ? <span>有文件变更</span> : null}
                      {entry.locked ? <span>已锁定</span> : null}
                    </div>
                    <p>{entry.path ?? "尚无工作树"}</p>
                    <div className="git-manager-origins">
                      {entry.branch ? (
                        <span>
                          分支：
                          <CreationOrigin origin={entry.branchOrigin} />
                        </span>
                      ) : null}
                      {entry.path ? (
                        <span>
                          worktree：
                          <CreationOrigin origin={entry.worktreeOrigin} />
                        </span>
                      ) : null}
                    </div>
                    <small>
                      {entry.headSha.slice(0, 8)}
                      {entry.deleteReason ? ` · ${entry.deleteReason}` : " · 已合并，可删除"}
                    </small>
                  </div>
                  <button
                    className="button"
                    type="button"
                    disabled={pending || Boolean(entry.deleteReason)}
                    title={entry.deleteReason ?? "删除分支及对应工作树"}
                    aria-label={`删除 ${entry.branch ?? entry.path}`}
                    onClick={() => {
                      setTarget(entry);
                      setFormOpen(false);
                      remove.reset();
                      create.reset();
                    }}
                  >
                    删除
                  </button>
                </li>
              ))}
            {!query.data.entries.length ? <li>仓库还没有提交，请先创建首个提交。</li> : null}
            {query.data.entries.length > 0 &&
            !query.data.entries.some((entry) =>
              `${entry.branch ?? "分离 HEAD"} ${entry.path ?? ""}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) ? (
              <li>没有匹配的分支或工作树</li>
            ) : null}
          </ul>
        </>
      ) : null}
    </>
  );
}

function CreationOrigin({ origin }: { readonly origin: GitCreationOrigin | undefined }) {
  if (origin?.kind === "codex")
    return (
      <a
        href={`codex://threads/${encodeURIComponent(origin.threadId)}`}
        title="打开创建此资源的 Codex 对话"
      >
        {origin.threadTitle ? `Codex 对话创建：${origin.threadTitle}` : "Codex 对话创建"}
      </a>
    );
  if (origin?.kind === "user") return <span>{origin.userName} 创建</span>;
  if (origin?.kind === "terminal") return <span>Terminal 创建</span>;
  return <span>来源未知</span>;
}
