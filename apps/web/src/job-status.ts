import type { JobStatus, JobView } from "@codexboard/contracts";

const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "canceling",
];

const CANCELABLE_JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
];

export function isJobActive(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

export function isJobCancelable(status: JobStatus): boolean {
  return CANCELABLE_JOB_STATUSES.includes(status);
}

type ExecutionState = Pick<JobView, "status" | "errorCode" | "errorSummary" | "cancelRequestedAt">;

export function isJobReconciling(job: ExecutionState | undefined): boolean {
  return Boolean(
    job &&
    job.status === "canceling" &&
    !job.cancelRequestedAt &&
    ["RESTART_UNCERTAIN", "CODEX_OUTCOME_UNKNOWN", "CONNECTOR_DISCONNECTED"].includes(
      job.errorCode ?? "",
    ),
  );
}

export function executionNotice(
  job: ExecutionState | undefined,
): { message: string; tone: "info" | "error" } | null {
  if (!job?.errorSummary) return null;
  if (isJobReconciling(job))
    return { message: "正在同步 Desktop 执行状态，请稍候。", tone: "info" };
  if (job.errorCode === "MODEL_AT_CAPACITY")
    return { message: "模型暂时繁忙，请稍后重试。", tone: "info" };
  if (["failed", "failed_recoverable"].includes(job.status))
    return { message: "任务执行失败，请重试。", tone: "error" };
  return null;
}
