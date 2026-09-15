import type { JobStatus } from "@codexboard/contracts";

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
