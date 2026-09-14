import { remoteReviewMessage } from "./remote-api";
import { RemoteNotice } from "./remote-notice";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RemoteReviewFile, RemoteReviewScope } from "@lark-codex/contracts";
import { readRemoteReview, readRemoteReviewFile, remoteErrorMessage } from "./remote-api";
import type { RemoteDiffLine } from "./remote-diff";
import { reviewHunks, reviewTree, type ReviewTree } from "./remote-review-model";
import { highlightReviewLine } from "./remote-review-highlight";
import { SfSymbol } from "./sf-symbol";
import "./remote-review.css";

const scopes: Record<RemoteReviewScope, string> = {
  unstaged: "未暂存",
  staged: "已暂存",
  branch: "分支",
  turn: "最近一轮",
};
function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  return (
    <span className="remote-diff-counts">
      {added != null && <span className="remote-added">+{added}</span>}
      {removed != null && <span className="remote-removed">−{removed}</span>}
    </span>
  );
}
function reviewQuery(id: string, scope: RemoteReviewScope, all: boolean, turnId?: string) {
  return {
    queryKey: ["remote-review", id, scope, all, turnId],
    queryFn: () => readRemoteReview(id, scope, all, turnId),
    retry: false as const,
    staleTime: 10_000,
  };
}
function fileQuery(
  id: string,
  scope: RemoteReviewScope,
  path: string,
  view: "diff" | "file",
  turnId?: string,
) {
  return {
    queryKey: ["remote-review-file", id, scope, path, view, turnId],
    queryFn: () => readRemoteReviewFile(id, scope, path, view, turnId),
    retry: false as const,
    staleTime: 10_000,
  };
}
function savedScope(): RemoteReviewScope {
  const scope = localStorage.getItem("remote-review-scope");
  return scope && Object.hasOwn(scopes, scope) ? (scope as RemoteReviewScope) : "branch";
}
export function RemoteReviewShortcut({ id, onOpen }: { id: string; onOpen: () => void }) {
  const review = useQuery({ ...reviewQuery(id, "branch", false), refetchInterval: 30_000 });
  if (!review.data?.changedCount || review.isError) return null;
  return (
    <div className="remote-review-shortcut-dock">
      <button
        className="remote-review-shortcut"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onOpen}
        aria-label="审核代码改动"
      >
        <span>{review.data.changedCount} 个文件</span>
        <Counts added={review.data.added} removed={review.data.removed} />
      </button>
    </div>
  );
}
const CodeLines = memo(function CodeLines({
  lines,
  path,
  label,
}: {
  lines: RemoteDiffLine[];
  path: string;
  label: string;
}) {
  const [limit, setLimit] = useState(2000);
  const rendered = useMemo(
    () =>
      lines.slice(0, limit).map((line) => {
        const text = line.kind === "metadata" ? line.text : line.text.slice(1);
        return {
          ...line,
          text,
          html: line.kind === "metadata" ? null : highlightReviewLine(text, path),
        };
      }),
    [lines, path, limit],
  );
  return (
    <>
      <pre className="remote-review-code" aria-label={label}>
        {rendered.map((line, index) => (
          <span className={`remote-review-line ${line.kind}`} key={index}>
            <span className="remote-review-line-number" aria-hidden="true">
              {line.newLine ?? line.oldLine ?? ""}
            </span>
            {line.html == null ? (
              <code>{line.text || " "}</code>
            ) : (
              <code dangerouslySetInnerHTML={{ __html: line.html || " " }} />
            )}
          </span>
        ))}
      </pre>
      {lines.length > limit && (
        <button className="remote-load-more" onClick={() => setLimit(limit + 2000)}>
          显示更多行（剩余 {lines.length - limit}）
        </button>
      )}
    </>
  );
});
function DiffCard({
  id,
  scope,
  file,
  turnId,
  collapsed,
  initialPath,
  onOpen,
}: {
  id: string;
  scope: RemoteReviewScope;
  file: RemoteReviewFile;
  turnId?: string | undefined;
  collapsed?: boolean | undefined;
  initialPath?: string | undefined;
  onOpen: () => void;
}) {
  const article = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "120px" },
    );
    if (article.current) observer.observe(article.current);
    return () => observer.disconnect();
  }, []);
  const content = useQuery({
    ...fileQuery(id, scope, file.path, "diff", turnId),
    enabled: visible,
    refetchInterval: visible ? 15_000 : false,
  });
  const hunks = useMemo(() => reviewHunks(content.data?.patch ?? ""), [content.data?.patch]);
  const positioned = useRef(false);
  useEffect(() => {
    if (initialPath !== file.path || positioned.current) return;
    const frame = requestAnimationFrame(() => {
      article.current?.scrollIntoView({ block: "start" });
      if (content.data) positioned.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialPath, file.path, content.data]);
  const directory = file.path.split("/").slice(0, -1).join("/");
  return (
    <article className="remote-review-card" ref={article} aria-label={`${file.path} 的改动`}>
      <header>
        <div className="remote-review-card-name">
          <strong>{file.path.split("/").at(-1)}</strong>
          {directory && <small>{directory}</small>}
        </div>
        <Counts added={file.added} removed={file.removed} />
        <button aria-label={`查看 ${file.path}`} onClick={onOpen}>
          <SfSymbol name="arrow.up.right.square" />
        </button>
      </header>
      {content.isPending && (
        <p className="remote-review-loading" role="status">
          <span className="remote-status-spinner" />
          正在读取差异…
        </p>
      )}
      {content.isError && (
        <RemoteNotice
          className="remote-review-notice"
          role="alert"
          action={
            <button
              className="remote-notice-refresh"
              disabled={content.isFetching}
              onClick={() => void content.refetch()}
            >
              {content.isFetching ? "刷新中…" : "刷新"}
            </button>
          }
        >
          {remoteErrorMessage(content.error)}
        </RemoteNotice>
      )}
      {content.data && (
        <>
          {file.previousPath && (
            <RemoteNotice className="remote-review-notice" role="status">
              {file.previousPath} → {file.path}
            </RemoteNotice>
          )}
          {content.data.message && (
            <RemoteNotice className="remote-review-notice" role="status">
              {remoteReviewMessage(content.data.message)}
            </RemoteNotice>
          )}
          {!content.data.binary &&
            !content.data.tooLarge &&
            hunks.map((hunk, index) => (
              <details
                className="remote-review-hunk"
                open={!collapsed}
                key={`${index}:${collapsed}`}
              >
                <summary>
                  <SfSymbol name="chevron.right" />
                  <span>{hunk.label}</span>
                  <Counts added={hunk.added} removed={hunk.removed} />
                </summary>
                <CodeLines lines={hunk.lines} path={file.path} label={`${file.path} 代码差异`} />
              </details>
            ))}
          {!hunks.length && !content.data.message && (
            <RemoteNotice className="remote-review-notice" role="status">
              {file.status === "renamed" ? "文件已重命名，没有文本差异" : "此文件没有文本差异"}
            </RemoteNotice>
          )}
        </>
      )}
    </article>
  );
}
function TreeNode({ node, onOpen }: { node: ReviewTree; onOpen: (path: string) => void }) {
  if (node.file)
    return (
      <button
        className="remote-review-tree-file"
        aria-label={`查看 ${node.path}`}
        onClick={() => onOpen(node.path)}
      >
        <SfSymbol name="doc.text" />
        <span>{node.name}</span>
      </button>
    );
  return (
    <details className="remote-review-directory">
      <summary>
        <SfSymbol name="chevron.right" className="remote-review-directory-chevron" />
        <SfSymbol name="folder" />
        <span>{node.name}</span>
      </summary>
      <div>
        {node.children.map((child) => (
          <TreeNode key={child.path} node={child} onOpen={onOpen} />
        ))}
      </div>
    </details>
  );
}
function FileReader({
  id,
  scope,
  path,
  onDone,
  turnId,
}: {
  id: string;
  scope: RemoteReviewScope;
  path: string;
  onDone: () => void;
  turnId?: string | undefined;
}) {
  const file = useQuery(fileQuery(id, scope, path, "file", turnId));
  const [shareError, setShareError] = useState("");
  const lines = useMemo(() => {
    const text = file.data?.content ?? "";
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    return lines.map((text, index) => ({
      text: ` ${text}`,
      kind: "context" as const,
      newLine: index + 1,
    }));
  }, [file.data?.content]);
  const share = async () => {
    if (!file.data) return;
    const name = path.split("/").at(-1) ?? "file.txt";
    const output = new File([file.data.content], name, { type: "text/plain" });
    setShareError("");
    try {
      if (navigator.canShare?.({ files: [output] })) await navigator.share({ files: [output] });
      else {
        const url = URL.createObjectURL(output);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        setShareError("无法共享文件，请重试");
    }
  };
  return (
    <div className="remote-review-reader">
      <header className="remote-review-reader-header">
        <button className="remote-review-done" onClick={onDone}>
          完成
        </button>
        <h2>{path.split("/").at(-1)}</h2>
        <button
          className="remote-icon"
          aria-label="共享文件"
          disabled={
            !file.data || file.data.binary || file.data.tooLarge || Boolean(file.data.message)
          }
          onClick={() => void share()}
        >
          <SfSymbol name="square.and.arrow.up" />
        </button>
      </header>
      <div className="remote-review-reader-body">
        <span className="remote-sr-only">
          {path} · {file.data?.contentLabel}
        </span>
        {file.isPending && (
          <p className="remote-review-loading" role="status">
            正在读取文件…
          </p>
        )}
        {file.isError && (
          <RemoteNotice
            className="remote-review-notice"
            role="alert"
            action={
              <button
                className="remote-notice-refresh"
                disabled={file.isFetching}
                onClick={() => void file.refetch()}
              >
                {file.isFetching ? "刷新中…" : "刷新"}
              </button>
            }
          >
            {remoteErrorMessage(file.error)}
          </RemoteNotice>
        )}
        {shareError && (
          <RemoteNotice
            className="remote-review-notice"
            role="alert"
            onDismiss={() => setShareError("")}
          >
            {shareError}
          </RemoteNotice>
        )}
        {file.data && (
          <>
            {file.data.message && (
              <RemoteNotice className="remote-review-notice" role="status">
                {remoteReviewMessage(file.data.message)}
              </RemoteNotice>
            )}
            {!file.data.binary &&
              !file.data.tooLarge &&
              (!file.data.message || Boolean(file.data.content)) &&
              (file.data.content ? (
                <CodeLines lines={lines} path={path} label={`${path} 文件内容`} />
              ) : (
                <RemoteNotice className="remote-review-notice" role="status">
                  空文件
                </RemoteNotice>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
export function RemoteReview({
  id,
  onClose,
  turnId,
  initialPath,
}: {
  id: string;
  onClose: () => void;
  turnId?: string | undefined;
  initialPath?: string | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  const dismiss = () => {
    if (closeTimer.current) return;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 220);
  };
  const drag = useRef<{ y: number; top: number; height: number; minTop: number } | undefined>(
    undefined,
  );
  const [dragStyle, setDragStyle] = useState<CSSProperties>();
  const [scope, setScope] = useState<RemoteReviewScope>(() => (turnId ? "turn" : savedScope()));
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(30);
  const [path, setPath] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const review = useQuery({ ...reviewQuery(id, scope, all, turnId), refetchInterval: 15_000 });
  const files = useMemo(
    () =>
      [...(review.data?.files ?? [])].sort((a, b) =>
        turnId && !all ? 0 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    [review.data, turnId, all],
  );
  const matches = useMemo(
    () =>
      files.filter((file) =>
        `${file.path}\n${file.previousPath ?? ""}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      ),
    [files, search],
  );
  const tree = useMemo(
    () =>
      reviewTree(
        files.filter((file) => !file.path.split("/").some((part) => part.startsWith("."))),
      ),
    [files],
  );
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.focus();
  }, []);
  return (
    <dialog
      className={`remote-review${expanded || path !== undefined ? " is-expanded" : ""}${path !== undefined ? " is-reading" : ""}${closing ? " is-closing" : ""}`}
      ref={dialog}
      style={dragStyle}
      aria-label="代码审核"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (path !== undefined) setPath(undefined);
        else dismiss();
      }}
      onClick={(event) => {
        if (
          event.target === dialog.current &&
          event.clientY < dialog.current.getBoundingClientRect().top
        )
          dismiss();
      }}
    >
      <div className="remote-review-browser" hidden={path !== undefined}>
        <header
          className="remote-review-header"
          onPointerDown={(event) => {
            if (!(event.target as HTMLElement).closest("button, select")) {
              const rect = dialog.current!.getBoundingClientRect();
              const minTop =
                (parseFloat(getComputedStyle(dialog.current!).getPropertyValue("--remote-top")) ||
                  0) + (parseFloat(getComputedStyle(dialog.current!).scrollPaddingTop) || 12);
              drag.current = { y: event.clientY, top: rect.top, height: rect.height, minTop };
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            const { y, top, height, minTop } = drag.current;
            const nextTop = Math.max(minTop, top + event.clientY - y);
            setDragStyle({
              top: nextTop,
              height: Math.max(100, height + top - nextTop),
              transition: "none",
            });
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            setDragStyle(undefined);
          }}
          onPointerUp={(event) => {
            if (!drag.current) return;
            const delta = event.clientY - drag.current.y;
            drag.current = undefined;
            if (delta > 35 && !expanded) {
              // Keep the released geometry while the exit animation moves down.
              // Clearing it here snaps the sheet back to its resting position.
              dismiss();
              return;
            }
            setDragStyle(undefined);
            if (delta < -35) setExpanded(true);
            if (delta > 35) setExpanded(false);
          }}
        >
          <button className="remote-icon" aria-label="关闭审核" onClick={dismiss}>
            <SfSymbol name="xmark" />
          </button>
          {all ? (
            <h2>文件</h2>
          ) : turnId ? (
            <div className="remote-review-scope">
              <h2>已更改 {review.data?.changedCount ?? "…"} 个文件</h2>
              <Counts added={review.data?.added ?? null} removed={review.data?.removed ?? null} />
            </div>
          ) : (
            <div className="remote-review-scope">
              <label>
                <span>{scopes[scope]}</span>
                <SfSymbol name="chevron.down" />
                <select
                  aria-label="审核范围"
                  value={scope}
                  onChange={(event) => {
                    const value = event.target.value as RemoteReviewScope;
                    setScope(value);
                    localStorage.setItem("remote-review-scope", value);
                    setLimit(30);
                  }}
                >
                  {Object.entries(scopes).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <Counts added={review.data?.added ?? null} removed={review.data?.removed ?? null} />
            </div>
          )}
          {all ? (
            <span className="remote-icon" />
          ) : (
            <button
              className="remote-icon"
              aria-label={
                turnId
                  ? collapsed
                    ? "展开所有差异"
                    : "折叠所有差异"
                  : expanded
                    ? "收起审核面板"
                    : "展开审核面板"
              }
              onClick={() => (turnId ? setCollapsed(!collapsed) : setExpanded(!expanded))}
            >
              <SfSymbol
                name={
                  (turnId ? !collapsed : expanded)
                    ? "arrow.down.right.and.arrow.up.left"
                    : "arrow.up.left.and.arrow.down.right"
                }
              />
            </button>
          )}
        </header>
        <div className="remote-review-tabs" role="tablist" aria-label="文件范围">
          <button
            role="tab"
            aria-selected={!all}
            aria-controls="remote-review-files"
            onClick={() => {
              setAll(false);
              setLimit(30);
            }}
          >
            已修改
          </button>
          <button
            role="tab"
            aria-selected={all}
            aria-controls="remote-review-files"
            onClick={() => {
              setAll(true);
              setLimit(200);
            }}
          >
            所有文件
          </button>
        </div>
        <div
          className={`remote-review-scroll${all ? " is-file-tree" : ""}`}
          id="remote-review-files"
          role="tabpanel"
          aria-label={all ? "所有文件" : "已修改"}
        >
          {review.isPending && (
            <p className="remote-review-loading" role="status">
              <span className="remote-status-spinner" />
              正在读取文件…
            </p>
          )}
          {review.isError && (
            <RemoteNotice
              className="remote-review-notice"
              role="alert"
              action={
                <button
                  className="remote-notice-refresh"
                  disabled={review.isFetching}
                  onClick={() => void review.refetch()}
                >
                  {review.isFetching ? "刷新中…" : "刷新"}
                </button>
              }
            >
              {remoteErrorMessage(review.error)}
            </RemoteNotice>
          )}
          {review.data && (
            <>
              <span className="remote-sr-only">
                {review.data.changedCount} 个文件已更改
                {review.data.baseRef ? `，对比 ${review.data.baseRef}` : ""}
              </span>
              {!review.data.countsComplete && (
                <span className="remote-sr-only">行数不含二进制或过大的文件</span>
              )}
              {review.data.message && (
                <RemoteNotice className="remote-review-notice" role="status">
                  {remoteReviewMessage(review.data.message)}
                </RemoteNotice>
              )}
              {!files.length && (
                <p className="remote-review-empty">
                  {all ? "暂无可显示的文件" : "此范围没有代码改动"}
                </p>
              )}
              {all ? (
                search.trim() ? (
                  <>
                    <div className="remote-review-search-results">
                      {matches.slice(0, limit).map((file) => (
                        <button
                          className="remote-review-search-file"
                          key={file.path}
                          aria-label={`查看 ${file.path}`}
                          onClick={() => setPath(file.path)}
                        >
                          <SfSymbol name="doc.text" />
                          <span>
                            <strong>{file.path.split("/").at(-1)}</strong>
                            <small>{file.path}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                    {!matches.length && <p className="remote-review-empty">没有匹配的文件</p>}
                    {matches.length > limit && (
                      <button className="remote-load-more" onClick={() => setLimit(limit + 200)}>
                        显示更多文件
                      </button>
                    )}
                  </>
                ) : (
                  <div className="remote-review-tree">
                    {tree.map((node) => (
                      <TreeNode key={node.path} node={node} onOpen={setPath} />
                    ))}
                  </div>
                )
              ) : (
                <>
                  {files.slice(0, limit).map((file) => (
                    <DiffCard
                      key={`${scope}:${file.path}`}
                      id={id}
                      scope={scope}
                      file={file}
                      turnId={turnId}
                      initialPath={initialPath}
                      collapsed={turnId ? collapsed : undefined}
                      onOpen={() => setPath(file.path)}
                    />
                  ))}
                  {files.length > limit && (
                    <button className="remote-load-more" onClick={() => setLimit(limit + 30)}>
                      显示更多文件（剩余 {files.length - limit}）
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
        {all && (
          <footer className="remote-review-search-dock">
            <label className="remote-review-search">
              <SfSymbol name="magnifyingglass" />
              <input
                type="search"
                aria-label="搜索文件"
                placeholder="搜索文件"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(200);
                }}
              />
            </label>
          </footer>
        )}
      </div>
      {path !== undefined && (
        <FileReader
          id={id}
          scope={scope}
          turnId={turnId}
          path={path}
          key={`${scope}:${path}`}
          onDone={() => setPath(undefined)}
        />
      )}
    </dialog>
  );
}
