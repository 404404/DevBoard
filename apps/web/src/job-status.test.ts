import { describe, expect, it } from "vitest";

import { isJobActive, isJobCancelable, executionNotice, isJobReconciling } from "./job-status";

describe("Codex job status policy", () => {
  it("keeps canceling active but prevents a duplicate cancellation", () => {
    expect(isJobActive("canceling")).toBe(true);
    expect(isJobCancelable("canceling")).toBe(false);
  });

  it.each(["queued", "running", "waiting_approval", "waiting_input"] as const)(
    "allows cancellation while the job is %s",
    (status) => {
      expect(isJobActive(status)).toBe(true);
      expect(isJobCancelable(status)).toBe(true);
    },
  );

  it.each(["succeeded", "failed", "failed_recoverable", "canceled"] as const)(
    "treats %s as neither active nor cancellable",
    (status) => {
      expect(isJobActive(status)).toBe(false);
      expect(isJobCancelable(status)).toBe(false);
    },
  );
});

it("does not present uncertain or transient execution states as failures", () => {
  const pending = {
    status: "canceling" as const,
    errorCode: "RESTART_UNCERTAIN",
    errorSummary: "awaiting owner",
    cancelRequestedAt: null,
  };
  expect(isJobReconciling(pending)).toBe(true);
  expect(executionNotice(pending)).toMatchObject({ tone: "info" });
  expect(executionNotice({ ...pending, status: "running" })).toBeNull();
  expect(executionNotice({ ...pending, status: "queued" })).toBeNull();
  expect(executionNotice({ ...pending, status: "failed", errorCode: "TURN_FAILED" })).toMatchObject(
    { tone: "error" },
  );
  expect(isJobReconciling({ ...pending, cancelRequestedAt: "2026-09-16T00:00:00Z" })).toBe(false);
});
