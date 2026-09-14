import { describe, expect, it } from "vitest";

import { safeStartupErrorDetails } from "../src/startup-error.js";

describe("safeStartupErrorDetails", () => {
  it("keeps the error class and a bounded system code without exposing the message", () => {
    const error = Object.assign(new Error("token=super-secret"), { code: "EADDRINUSE" });

    expect(safeStartupErrorDetails(error)).toEqual({
      errorName: "Error",
      systemErrorCode: "EADDRINUSE",
    });
    expect(JSON.stringify(safeStartupErrorDetails(error))).not.toContain("super-secret");
  });

  it("drops untrusted error codes", () => {
    const error = Object.assign(new Error("safe"), { code: "token=secret" });

    expect(safeStartupErrorDetails(error)).toEqual({ errorName: "Error" });
    expect(safeStartupErrorDetails("not-an-error")).toEqual({ errorName: "UnknownError" });
  });
});
