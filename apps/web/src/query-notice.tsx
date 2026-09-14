import { NoticeBar } from "./notice-bar";
import { userErrorMessage } from "./user-error";

export function QueryNotice({
  error,
  fallback,
  onRetry,
  refreshing = false,
}: {
  readonly error: unknown;
  readonly fallback?: string;
  readonly onRetry: () => void;
  readonly refreshing?: boolean;
}) {
  return (
    <NoticeBar
      className="query-notice"
      action={
        <button type="button" onClick={onRetry} disabled={refreshing}>
          {refreshing ? "重试中…" : "重试"}
        </button>
      }
    >
      {userErrorMessage(error, fallback)}
    </NoticeBar>
  );
}
