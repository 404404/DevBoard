import { describe, expect, it } from "vitest";
import { normalizeLarkCodexEnvironment } from "./environment.js";

describe("environment brand compatibility", () => {
  it("normalizes legacy settings without mutating callers or unrelated variables", () => {
    const input = { LARK_TASKBOARD_PORT: "12345", OTHER: "unchanged" };
    expect(normalizeLarkCodexEnvironment(input)).toEqual({
      LARK_CODEX_PORT: "12345",
      OTHER: "unchanged",
    });
    expect(input.LARK_TASKBOARD_PORT).toBe("12345");
  });

  it("gives explicitly configured new values priority, including empty strings", () => {
    expect(
      normalizeLarkCodexEnvironment({
        LARK_CODEX_PORT: "47823",
        LARK_TASKBOARD_PORT: "12345",
        LARK_CODEX_AUTH_FILE: "",
        LARK_TASKBOARD_AUTH_FILE: "/old/auth",
      }),
    ).toEqual({ LARK_CODEX_PORT: "47823", LARK_CODEX_AUTH_FILE: "" });
  });
});
