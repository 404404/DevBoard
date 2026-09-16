import type { JobStatus } from "@codexboard/contracts";
import { isJobActive } from "./job-status";

export function executionAvailability(input: {
  hasStarted: boolean;
  reconciling?: boolean;
  status?: JobStatus;
  pendingComments: boolean;
}) {
  const active = input.status ? isJobActive(input.status) : false;
  const retryable =
    input.status === "failed" ||
    input.status === "failed_recoverable" ||
    input.status === "canceled";
  return {
    canSubmit: !active && (!input.hasStarted || retryable || input.pendingComments),
    reason: input.reconciling
      ? "正在同步 Desktop 执行状态"
      : active
        ? input.status === "canceling"
          ? "正在等待 Codex 确认停止"
          : "当前执行尚未结束"
        : input.hasStarted && !retryable && !input.pendingComments
          ? "没有待执行的新评论"
          : null,
  };
}
