import { RemoteActivityIcon } from "./remote-tool-item";
import {
  splitRemoteTurn,
  remoteDuration,
  groupRemoteProgress,
  remoteCommandRows,
  remoteCommandGroupLabel,
  remoteActivityHeader,
  type RemoteCommandAction,
} from "./remote-turn-model";
import { useEffect, useState, type ReactNode } from "react";
import type { RemoteThread } from "@lark-codex/contracts";

type Turn = RemoteThread["turns"][number];
type Item = Turn["items"][number];

export function RemoteTurnContent({
  turn,
  renderItem,
  changes,
  showActivityStatus = true,
}: {
  turn: Turn;
  renderItem: (item: Item, action?: RemoteCommandAction, after?: ReactNode) => ReactNode;
  changes: ReactNode;
  showActivityStatus?: boolean;
}) {
  const active = turn.status === "inProgress";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || turn.startedAtMs == null || turn.workDurationMs != null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, turn.startedAtMs, turn.workDurationMs]);
  const parts = splitRemoteTurn(turn);
  const progressGroups = groupRemoteProgress(parts.progress);
  const statusActive =
    active && showActivityStatus && !parts.final.some((item) => !item.asyncQuestions?.length);
  const hasStatusGroup = progressGroups.at(-1)?.kind === "commands";
  const duration =
    turn.workDurationMs ??
    (active && turn.startedAtMs != null ? Math.max(0, now - turn.startedAtMs) : turn.durationMs);
  const label = active
    ? "执行中"
    : turn.status === "interrupted"
      ? "已停止"
      : turn.status === "failed"
        ? "执行失败"
        : "执行过程";
  return (
    <>
      {parts.users.map((item) => renderItem(item))}
      {(progressGroups.length > 0 || duration != null) && (
        <details className="remote-progress" key={active ? "active" : "finished"} open={active}>
          <summary>
            <span>
              {active ? label : duration != null ? "用时" : label}
              {duration != null ? ` ${remoteDuration(duration)}` : ""}
            </span>
          </summary>
          <div className="remote-progress-content">
            {progressGroups.map((group, index) => {
              if (group.kind !== "commands") return group.items.map((item) => renderItem(item));
              const rows = remoteCommandRows(group.items);
              const live = statusActive && index === progressGroups.length - 1;
              const header = live ? remoteActivityHeader(group.items) : null;
              if (rows.length === 1 && !live)
                return <div key={rows[0]!.key}>{renderItem(rows[0]!.item, rows[0]!.action)}</div>;
              return (
                <details
                  className={`remote-command-group${live ? " remote-activity-live" : ""}`}
                  key={group.items[0]!.id}
                >
                  <summary>
                    {header ? (
                      <>
                        {header.kind && <RemoteActivityIcon kind={header.kind} />}
                        <span className="remote-thinking remote-activity-label" role="status">
                          {header.label}
                        </span>
                      </>
                    ) : (
                      <>
                        <RemoteActivityIcon
                          kind={rows.some((row) => row.action) ? "read" : "command"}
                        />
                        <span className="remote-activity-label">
                          {remoteCommandGroupLabel(rows)}
                        </span>
                      </>
                    )}
                  </summary>
                  <div className="remote-activity-items">
                    {rows.map((row) => (
                      <div key={row.key}>{renderItem(row.item, row.action)}</div>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </details>
      )}
      {statusActive && !hasStatusGroup && (
        <div className="remote-working" role="status">
          <span className="remote-thinking">正在思考</span>
        </div>
      )}
      {parts.final.map((item, index) =>
        renderItem(item, undefined, index === parts.final.length - 1 ? changes : undefined),
      )}
      {!parts.final.length && changes}
    </>
  );
}
