import { expect, it } from "vitest";
import { executionAvailability } from "./execution-availability";

it("disables continuation while cancellation is awaiting confirmation", () => {
  expect(
    executionAvailability({ hasStarted: true, status: "canceling", pendingComments: true })
      .canSubmit,
  ).toBe(false);
});
it("disables an empty continuation after success, but permits new comments and retries", () => {
  expect(
    executionAvailability({ hasStarted: true, status: "succeeded", pendingComments: false })
      .canSubmit,
  ).toBe(false);
  expect(
    executionAvailability({ hasStarted: true, status: "succeeded", pendingComments: true })
      .canSubmit,
  ).toBe(true);
  expect(
    executionAvailability({ hasStarted: true, status: "canceled", pendingComments: false })
      .canSubmit,
  ).toBe(true);
  expect(
    executionAvailability({ hasStarted: true, status: "failed", pendingComments: false }).canSubmit,
  ).toBe(true);
});
it("allows the first turn of a draft without requiring a comment", () => {
  expect(executionAvailability({ hasStarted: false, pendingComments: false }).canSubmit).toBe(true);
});
