import { QueryNotice } from "./query-notice";
import { userErrorMessage } from "./user-error";
import { sameIdentity } from "@lark-taskboard/contracts";
import { Notice } from "./notification-center";
import type {
  PrincipalView,
  ActivityView,
  AttachmentView,
  CommentView,
  TaskView,
} from "@lark-taskboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Paperclip, Trash2 } from "./icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAttachmentTransfer } from "./use-attachment-transfer";

import {
  createComment,
  deleteComment,
  deleteAttachment,
  markTaskRead,
  readTaskWorkspace,
  updateComment,
  uploadAttachment,
} from "./api";
import { describeActivity } from "./task-activity";
import { PersonAvatar } from "./person-avatar";
import codexDesktopIcon from "./assets/codex-desktop.png";
import { SfSymbol } from "./sf-symbol";
import { MarkdownContent } from "./markdown";
import { jobStatusLabel, useUiCopy } from "./locale";
import { createUuid } from "./random-id";

function message(error: unknown, fallback: string): string {
  return userErrorMessage(error, fallback);
}

export function TaskWorkspacePanel({
  task,
  actor,
  csrfToken,
  writable,
  onDraftChange,
}: {
  readonly task: TaskView;
  readonly actor: PrincipalView;
  readonly csrfToken: string;
  readonly writable: boolean;
  readonly onDraftChange?: (key: string, dirty: boolean) => void;
}) {
  const copy = useUiCopy();
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace", task.id],
    queryFn: () => readTaskWorkspace(task.id),
    refetchInterval: 5_000,
  });
  useEffect(() => {
    void markTaskRead(task.id, csrfToken)
      .then(() => queryClient.invalidateQueries({ queryKey: ["dashboard", task.projectId] }))
      .catch(() => undefined);
  }, [csrfToken, queryClient, task.id, task.projectId]);

  if (workspace.isPending) {
    return (
      <div className="workspace-loading">
        <LoaderCircle className="spin" aria-hidden="true" />
        {copy.workspaceLoading}
      </div>
    );
  }
  if (workspace.isError && !workspace.data) {
    return (
      <QueryNotice
        error={workspace.error}
        fallback="任务记录暂时无法加载，请重试。"
        refreshing={workspace.isFetching}
        onRetry={() => void workspace.refetch()}
      />
    );
  }
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace", task.id] });
    void queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    void queryClient.invalidateQueries({ queryKey: ["board"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard", task.projectId] });
  };
  return (
    <div className="task-workspace-panel">
      <CommentsSection
        attachments={workspace.data.attachments}
        activities={workspace.data.activities}
        comments={workspace.data.comments}
        taskId={task.id}
        actor={actor}
        csrfToken={csrfToken}
        writable={writable}
        onChanged={refresh}
        onDraftChange={onDraftChange}
      />
      <section className="workspace-section execution-summary" aria-label={copy.executionSummary}>
        <header>
          <h3>{copy.executionSummary}</h3>
          <span>{workspace.data.executionSummary.total}</span>
        </header>
        <p>{copy.activeJobs(workspace.data.executionSummary.active)}</p>
        {workspace.data.executionSummary.latest ? (
          <small>
            {copy.latestStatus(jobStatusLabel(workspace.data.executionSummary.latest.status))} ·{" "}
            {new Date(workspace.data.executionSummary.latest.updatedAt).toLocaleString("zh-CN")}
          </small>
        ) : (
          <small>{copy.noExecutionSummary}</small>
        )}
      </section>
    </div>
  );
}

function CommentsSection({
  attachments,
  activities,
  comments,
  taskId,
  actor,
  csrfToken,
  writable,
  onChanged,
  onDraftChange,
}: {
  readonly attachments: readonly AttachmentView[];
  readonly activities: readonly ActivityView[];
  readonly comments: readonly CommentView[];
  readonly taskId: string;
  readonly actor: PrincipalView;
  readonly csrfToken: string;
  readonly writable: boolean;
  readonly onChanged: () => void;
  readonly onDraftChange?: ((key: string, dirty: boolean) => void) | undefined;
}) {
  const copy = useUiCopy();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<{ file: File; key: string }[]>([]);
  const uploaded = useRef(new Map<string, AttachmentView>());
  const submission = useRef({ signature: "", key: createUuid() });
  const [fileError, setFileError] = useState("");
  const [removingFile, setRemovingFile] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [conversationExpanded, setConversationExpanded] = useState(true);
  const create = useMutation({
    mutationFn: async () => {
      const attachmentIds: string[] = [];
      for (const entry of files) {
        let attachment = uploaded.current.get(entry.key);
        if (!attachment) {
          attachment = await uploadAttachment(taskId, entry.file, csrfToken, entry.key, true);
          uploaded.current.set(entry.key, attachment);
        }
        attachmentIds.push(attachment.id);
      }
      const signature = JSON.stringify({ body, attachmentIds });
      if (submission.current.signature !== signature)
        submission.current = { signature, key: createUuid() };
      return createComment(taskId, body, csrfToken, attachmentIds, submission.current.key);
    },
    onSuccess() {
      setBody("");
      setFiles([]);
      uploaded.current.clear();
      setFileError("");
      onChanged();
    },
  });
  const composerDirty = Boolean(body.trim() || files.length || create.isPending || removingFile);
  useEffect(() => {
    onDraftChange?.("composer", composerDirty);
    return () => onDraftChange?.("composer", false);
  }, [onDraftChange, composerDirty]);
  const addFiles = (selected: File[]) =>
    setFiles((current) => [...current, ...selected.map((file) => ({ file, key: createUuid() }))]);
  const transfer = useAttachmentTransfer({
    enabled: writable && !create.isPending && !removingFile,
    onFiles: addFiles,
    unavailableMessage: "评论正在提交，请稍后再添加附件。",
  });
  const timeline = activities
    .filter((activity) => activity.kind !== "comment.created")
    .map((activity) => ({ value: activity }))
    .sort((left, right) => left.value.createdAt.localeCompare(right.value.createdAt));
  const conversation = [...comments].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return (
    <>
      <section
        className="workspace-section detail-conversation-section"
        aria-labelledby="conversation-title"
      >
        <header>
          <h3 id="conversation-title">
            <button
              type="button"
              className="activity-toggle"
              aria-expanded={conversationExpanded}
              aria-controls="conversation-content"
              onClick={() => setConversationExpanded(!conversationExpanded)}
            >
              <SfSymbol
                name="chevron.right"
                size={12}
                className={conversationExpanded ? "is-expanded" : ""}
              />
              对话
            </button>
          </h3>
          <span>{conversation.length}</span>
        </header>
        <div id="conversation-content" hidden={!conversationExpanded}>
          <div className="detail-activity-stream">
            {conversation.map((comment) => (
              <div className="detail-activity-entry detail-activity-comment" key={comment.id}>
                <CommentItem
                  key={`${comment.id}:${comment.version}`}
                  comment={comment}
                  attachments={attachments.filter(
                    (attachment) => attachment.commentId === comment.id,
                  )}
                  actor={actor}
                  csrfToken={csrfToken}
                  writable={writable}
                  onChanged={onChanged}
                  onDraftChange={onDraftChange}
                />
              </div>
            ))}
          </div>
          {writable ? (
            <div
              className={`comment-composer attachment-drop-zone ${transfer.dragging ? "is-dragging" : ""}`}
              role="group"
              aria-label={copy.comments}
              {...transfer.handlers}
            >
              {transfer.dragging && (
                <span className="attachment-drop-hint">松开以添加评论附件</span>
              )}
              <textarea
                aria-label={copy.newComment}
                rows={3}
                maxLength={100_000}
                placeholder={`${copy.commentPlaceholder}，可粘贴或拖入附件`}
                value={body}
                disabled={create.isPending}
                onChange={(event) => setBody(event.target.value)}
              />
              {files.length > 0 && (
                <ul className="comment-pending-files" aria-label="待发送附件">
                  {files.map((entry) => (
                    <li key={entry.key}>
                      <Paperclip aria-hidden="true" />
                      <span>
                        {entry.file.name}
                        <small>{formatBytes(entry.file.size)}</small>
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`移除待发送附件 ${entry.file.name}`}
                        disabled={create.isPending || removingFile}
                        onClick={async () => {
                          setRemovingFile(true);
                          setFileError("");
                          try {
                            const attachment = uploaded.current.get(entry.key);
                            if (attachment) await deleteAttachment(attachment.id, csrfToken);
                            uploaded.current.delete(entry.key);
                            setFiles((current) => current.filter((item) => item.key !== entry.key));
                            onChanged();
                          } catch (error) {
                            setFileError(message(error, "移除附件失败，请重试"));
                          } finally {
                            setRemovingFile(false);
                          }
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="comment-composer-toolbar">
                <label className="attachment-upload comment-attachment-upload">
                  <Paperclip aria-hidden="true" />
                  <span>添加附件</span>
                  <input
                    type="file"
                    multiple
                    aria-label="添加评论附件"
                    disabled={create.isPending || removingFile}
                    onChange={(event) => {
                      addFiles(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                </label>
                <small>Markdown</small>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={
                    (!body.trim() && files.length === 0) || create.isPending || removingFile
                  }
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? "正在发表…" : copy.postComment}
                </button>
              </div>
              {transfer.error && <Notice message={transfer.error} eventKey={transfer.error} />}
              {fileError && <Notice message={fileError} />}
              {create.isError ? (
                <Notice
                  message={message(create.error, copy.operationFailed)}
                  eventKey={create.error}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
      <section
        className="workspace-section detail-activity-section"
        aria-labelledby="activity-title"
      >
        <header>
          <h3 id="activity-title">
            <button
              type="button"
              className="activity-toggle"
              aria-expanded={expanded}
              aria-controls="activity-content"
              onClick={() => setExpanded(!expanded)}
            >
              <SfSymbol name="chevron.right" size={12} className={expanded ? "is-expanded" : ""} />
              {copy.activity}
            </button>
          </h3>
          <span>{timeline.length}</span>
        </header>
        <div id="activity-content" hidden={!expanded}>
          <div className="detail-activity-stream">
            {timeline.map((item) => (
              <div className="detail-activity-entry" key={`activity:${item.value.id}`}>
                {item.value.actor ? (
                  <PersonAvatar person={item.value.actor} />
                ) : (
                  <img className="system-activity-avatar" src={codexDesktopIcon} alt="" />
                )}
                <div className="activity-description">
                  <p>
                    <strong>{item.value.actor?.name ?? copy.system}</strong>{" "}
                    {describeActivity(item.value.kind, item.value.changes)
                      .map(({ summary }) => summary)
                      .join("；")}{" "}
                    <time dateTime={item.value.createdAt}>
                      {new Date(item.value.createdAt).toLocaleString("zh-CN")}
                    </time>
                  </p>
                  {describeActivity(item.value.kind, item.value.changes)
                    .filter((detail) => detail.before !== undefined)
                    .map((detail, index) => (
                      <details className="activity-value-diff" key={index}>
                        <summary>查看{detail.summary.replace("修改了", "")}变更</summary>
                        <span>修改前</span>
                        <pre>{detail.before}</pre>
                        <span>修改后</span>
                        <pre>{detail.after}</pre>
                      </details>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function CommentItem({
  comment,
  attachments,
  actor,
  csrfToken,
  writable,
  onChanged,
  onDraftChange,
}: {
  readonly comment: CommentView;
  readonly attachments: readonly AttachmentView[];
  readonly actor: PrincipalView;
  readonly csrfToken: string;
  readonly writable: boolean;
  readonly onChanged: () => void;
  readonly onDraftChange?: ((key: string, dirty: boolean) => void) | undefined;
}) {
  const copy = useUiCopy();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target))
        setMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  const [body, setBody] = useState(comment.body);
  const update = useMutation({
    mutationFn: () => updateComment(comment.id, comment.version, body, csrfToken),
    onSuccess() {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteComment(comment.id, comment.version, csrfToken),
    onSuccess: onChanged,
  });
  const commentDirty = editing || update.isPending || remove.isPending;
  useEffect(() => {
    onDraftChange?.(comment.id, commentDirty);
    return () => onDraftChange?.(comment.id, false);
  }, [onDraftChange, comment.id, commentDirty]);
  const owned =
    writable &&
    comment.source !== "codex" &&
    !comment.executedAt &&
    actor.identity.kind === "feishu" &&
    sameIdentity(comment.author?.identity, actor.identity) &&
    comment.deletedAt === null;
  return (
    <article className={`comment ${comment.deletedAt ? "comment--deleted" : ""}`}>
      <header>
        {comment.source === "codex" ? (
          <img className="system-activity-avatar" src={codexDesktopIcon} alt="" />
        ) : (
          <PersonAvatar person={comment.author} />
        )}
        <strong>
          {comment.source === "codex" ? "Codex" : (comment.author?.name ?? copy.deletedUser)}
        </strong>
        <small>{new Date(comment.createdAt).toLocaleString("zh-CN")}</small>
        {comment.source === "codex" && comment.codexThreadId && (
          <a
            className="comment-codex-link"
            href={`codex://threads/${encodeURIComponent(comment.codexThreadId)}`}
          >
            打开 Codex 对话
          </a>
        )}
        {comment.source !== "codex" && comment.executedAt && (
          <small title="此评论已提交执行，不能编辑或删除">已执行</small>
        )}
      </header>
      {editing ? (
        <textarea
          autoFocus
          aria-label={copy.editComment}
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      ) : comment.deletedAt ? (
        <p>{copy.commentDeleted}</p>
      ) : (
        <MarkdownContent markdown={comment.body} />
      )}
      {!comment.deletedAt && attachments.length > 0 && (
        <AttachmentsSection
          attachments={attachments}
          csrfToken={csrfToken}
          writable={owned}
          onChanged={onChanged}
          label="评论附件"
        />
      )}
      {owned ? (
        <div className="comment-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="button button--primary"
                disabled={!body.trim() || update.isPending}
                onClick={() => update.mutate()}
              >
                {copy.save}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setBody(comment.body);
                  setEditing(false);
                }}
              >
                {copy.cancel}
              </button>
            </>
          ) : (
            <div
              ref={menuRef}
              className="comment-menu"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setMenuOpen(false);
                  menuTrigger.current?.focus();
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const items = Array.from(
                    menuRef.current?.querySelectorAll<HTMLButtonElement>(
                      '[role="menuitem"]:not(:disabled)',
                    ) ?? [],
                  );
                  const current = items.indexOf(document.activeElement as HTMLButtonElement);
                  items[
                    (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                  ]?.focus();
                }
              }}
            >
              <button
                ref={menuTrigger}
                type="button"
                className="icon-button comment-menu-trigger"
                aria-label="评论操作"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <SfSymbol name="ellipsis" size={18} />
              </button>
              {menuOpen && (
                <div className="comment-menu-options" role="menu" aria-label="评论操作菜单">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setEditing(true);
                    }}
                  >
                    编辑评论
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="comment-delete"
                    disabled={remove.isPending}
                    onClick={() => {
                      setMenuOpen(false);
                      remove.mutate();
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    {copy.deleteComment}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
      {update.isError || remove.isError ? (
        <Notice
          message={message(update.error ?? remove.error, copy.operationFailed)}
          eventKey={update.error ?? remove.error}
        />
      ) : null}
    </article>
  );
}

export function TaskDescriptionAttachments({
  taskId,
  csrfToken,
  writable,
  editing,
  onEditingEnd,
  children,
  onDraftChange,
}: {
  readonly taskId: string;
  readonly csrfToken: string;
  readonly writable: boolean;
  readonly editing: boolean;
  readonly onEditingEnd: () => void;
  readonly children: (attachmentControl: ReactNode) => ReactNode;
  readonly onDraftChange?: (key: string, dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace", taskId],
    queryFn: () => readTaskWorkspace(taskId),
    refetchInterval: 5_000,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace", taskId] });
  };
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await uploadAttachment(taskId, file, csrfToken);
    },
    onSettled: refresh,
  });
  useEffect(() => {
    onDraftChange?.("description-attachment", upload.isPending);
    return () => onDraftChange?.("description-attachment", false);
  }, [onDraftChange, upload.isPending]);
  const transfer = useAttachmentTransfer({
    enabled: writable && editing && !upload.isPending,
    onFiles: (files) => upload.mutate(files),
    unavailableMessage: writable ? "附件正在上传，请稍后再试。" : "当前任务只读，无法添加附件。",
  });
  return (
    <div
      className={`detail-description-zone attachment-drop-zone ${transfer.dragging ? "is-dragging" : ""}`}
      role="group"
      aria-label="描述与附件"
      onBlur={(event) => {
        if (editing && !event.currentTarget.contains(event.relatedTarget)) onEditingEnd();
      }}
      {...transfer.handlers}
    >
      {transfer.dragging && <span className="attachment-drop-hint">松开以添加描述附件</span>}
      {children(
        writable && editing ? (
          <div className="detail-description-toolbar">
            <label className="attachment-upload">
              <Paperclip aria-hidden="true" />
              <span>{upload.isPending ? "上传中…" : "添加附件"}</span>
              <input
                type="file"
                multiple
                aria-label="添加描述附件"
                disabled={upload.isPending}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length) upload.mutate(files);
                  event.target.value = "";
                }}
              />
            </label>
            <small>可直接粘贴或拖入文件</small>
          </div>
        ) : null,
      )}
      {workspace.data ? (
        <AttachmentsSection
          attachments={workspace.data.attachments.filter((attachment) => !attachment.commentId)}
          csrfToken={csrfToken}
          writable={writable}
          onChanged={refresh}
        />
      ) : workspace.isError ? (
        <>
          <Notice message="附件加载失败。" eventKey={workspace.error} />
          <button type="button" onClick={() => void workspace.refetch()}>
            重试
          </button>
        </>
      ) : null}
      {(transfer.error || upload.isError) && (
        <Notice
          message={transfer.error || message(upload.error, "附件上传失败，请重试。")}
          eventKey={transfer.error ?? upload.error}
        />
      )}
    </div>
  );
}

function AttachmentsSection({
  attachments,
  csrfToken,
  writable,
  onChanged,
  label = "描述附件",
}: {
  readonly attachments: readonly import("@lark-taskboard/contracts").AttachmentView[];
  readonly csrfToken: string;
  readonly writable: boolean;
  readonly onChanged: () => void;
  readonly label?: string;
}) {
  const copy = useUiCopy();
  const [preview, setPreview] = useState<(typeof attachments)[number] | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => deleteAttachment(id, csrfToken),
    onSuccess: onChanged,
  });
  return (
    <div className="inline-attachments" role="group" aria-label={label}>
      <div className="attachment-list">
        {attachments.length > 0 &&
          attachments.map((attachment) => (
            <div className="attachment-row" key={attachment.id}>
              <a
                href={attachment.downloadUrl}
                onClick={(event) => {
                  if (attachment.contentType.startsWith("image/")) {
                    event.preventDefault();
                    setPreview(attachment);
                  }
                }}
              >
                <span>
                  <strong>{attachment.filename}</strong>
                  <small>
                    {formatBytes(attachment.sizeBytes)} ·{" "}
                    {attachment.uploader?.name ?? copy.unknown}
                  </small>
                </span>
                <Paperclip aria-hidden="true" />
              </a>
              {writable && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`删除附件 ${attachment.filename}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(attachment.id)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
      </div>
      {preview && <ImagePreview attachment={preview} onClose={() => setPreview(null)} />}
      {remove.isError ? (
        <Notice message={message(remove.error, copy.operationFailed)} eventKey={remove.error} />
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function ImagePreview({
  attachment,
  onClose,
}: {
  readonly attachment: import("@lark-taskboard/contracts").AttachmentView;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="attachment-preview"
      aria-label={`预览图片 ${attachment.filename}`}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="attachment-preview-content">
        <header>
          <strong>{attachment.filename}</strong>
          <button
            autoFocus
            className="icon-button"
            type="button"
            aria-label="关闭图片预览"
            onClick={onClose}
          >
            <SfSymbol name="xmark" size={18} />
          </button>
        </header>
        {failed ? (
          <Notice message="图片加载失败，可下载后查看。" />
        ) : (
          <img
            src={`${attachment.downloadUrl}?preview=1`}
            alt={attachment.filename}
            onError={() => setFailed(true)}
          />
        )}
        <a href={attachment.downloadUrl}>下载原图</a>
      </div>
    </dialog>
  );
}
