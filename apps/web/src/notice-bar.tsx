import type { ReactNode } from "react";
import { SfSymbol } from "./sf-symbol";

/** Shared compact presentation for board and Remote notices. */
export function NoticeBar({
  children,
  action,
  className = "",
  role = "alert",
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly role?: "alert" | "status";
}) {
  return (
    <div className={`notice-bar ${className}`} role={role}>
      {role === "alert" && <SfSymbol name="exclamationmark.triangle" size={16} />}
      <div className="notice-bar-content">{children}</div>
      {action && <div className="notice-bar-action">{action}</div>}
    </div>
  );
}
