import { NoticeBar } from "./notice-bar";
import { type ReactNode } from "react";
import { SfSymbol } from "./sf-symbol";

export function RemoteNotice({
  children,
  className = "remote-error",
  role = "alert",
  onDismiss,
  action,
}: {
  children: ReactNode;
  className?: string;
  role?: "alert" | "status";
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  return (
    <NoticeBar
      className={`remote-notice ${className}`}
      role={role}
      action={
        action ??
        (onDismiss && (
          <button
            className="remote-notice-close"
            type="button"
            aria-label="关闭提示"
            onClick={onDismiss}
          >
            <SfSymbol name="xmark" />
          </button>
        ))
      }
    >
      {children}
    </NoticeBar>
  );
}
