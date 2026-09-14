import { describe, expect, it } from "vitest";

import { isJobActive, isJobCancelable } from "./job-status";

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
