import { MarkdownContent } from "./markdown";
import { SfSymbol } from "./sf-symbol";
import { RemoteImages } from "./remote-images";
import {
  remoteCommandSource,
  remoteCommandLabel,
  type RemoteItem,
  type RemoteCommandAction,
} from "./remote-turn-model";

export function RemoteActivityIcon({ kind }: { kind: string }) {
  if (kind === "read")
    return (
      <svg
        className="remote-activity-icon"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9.5 5C7 2.5 4 2 2 3v13c2-.6 5-.1 7.5 2M10.5 5C13 2.5 16 2 18 3v13c-2-.6-5-.1-7.5 2M10 5v13" />
      </svg>
    );
  return (
    <SfSymbol
      name={
        kind === "search"
          ? "magnifyingglass"
          : kind === "listFiles" || kind === "fileChange"
            ? "folder"
            : kind === "imageView"
              ? "photo"
              : kind === "reasoning"
                ? "lightbulb"
                : kind === "automaticApprovalReview" || kind === "permissionRequest"
                  ? "checkmark.seal"
                  : "apple.terminal"
      }
    />
  );
}
function statusLabel(item: RemoteItem) {
  if (item.status === "inProgress") return "执行中";
  if (item.status === "failed" || (item.exitCode != null && item.exitCode !== 0)) return "失败";
  if (item.status === "declined" || item.status === "denied") return "已拒绝";
  if (item.status === "interrupted" || item.status === "aborted") return "已停止";
  return item.status === "completed" || item.exitCode === 0 ? "成功" : "";
}
export function RemoteToolItem({
  item,
  threadId,
  action,
}: {
  item: RemoteItem;
  threadId: string;
  action?: RemoteCommandAction | undefined;
}) {
  const command = item.type === "commandExecution";
  const status = statusLabel(item);
  const title = command
    ? remoteCommandLabel(item, action)
    : item.type === "imageView"
      ? `已查看 ${item.images?.length || 1} 张图像`
      : item.text.split("\n")[0] || "执行详情";
  return (
    <details
      className={`remote-tool${command ? " remote-command-item" : ""}${action ? " remote-read-item" : ""}`}
    >
      <summary>
        <RemoteActivityIcon kind={action?.type ?? item.type} />
        <span className="remote-tool-title">{title}</span>
      </summary>
      {command ? (
        <div className="remote-shell-card">
          <div className="remote-shell-heading">Shell</div>
          <pre className="remote-shell-command">$ {remoteCommandSource(item.text)}</pre>
          {action && (item.commandActions?.length ?? 0) > 1 && (
            <p className="remote-shell-note">以下为这次命令的完整输出</p>
          )}
          {item.detail ? (
            <pre className="remote-shell-output">{item.detail}</pre>
          ) : (
            <p className="remote-shell-empty">
              {item.status === "inProgress" ? "等待输出…" : "无输出"}
            </p>
          )}
          {status && (
            <div
              className={`remote-shell-result${status === "失败" || status === "已拒绝" ? " remote-shell-result-error" : ""}`}
            >
              {status === "成功" && <SfSymbol name="checkmark" />}
              <span>
                {status}
                {item.exitCode != null && item.exitCode !== 0 ? ` · 退出码 ${item.exitCode}` : ""}
              </span>
            </div>
          )}
        </div>
      ) : item.type === "reasoning" ? (
        <MarkdownContent markdown={item.detail} />
      ) : item.type === "imageView" ? (
        <RemoteImages threadId={threadId} item={item} />
      ) : item.detail ? (
        <pre>{item.detail}</pre>
      ) : null}
      {item.sections?.map((section, index) => (
        <details className="remote-tool-section" key={`${section.title}-${index}`}>
          <summary>{section.title}</summary>
          <pre>{section.text || "暂无详细输出"}</pre>
        </details>
      ))}
    </details>
  );
}
