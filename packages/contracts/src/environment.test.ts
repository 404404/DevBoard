import { describe, expect, it } from "vitest";
import { normalizeCodexBoardEnvironment } from "./environment.js";

describe("environment brand compatibility", () => {
  it("prefers the latest legacy prefix regardless of input order and removes both aliases", () => {
    for (const input of [
      { LARK_TASKBOARD_PORT: "11111", LARK_CODEX_PORT: "22222" },
      { LARK_CODEX_PORT: "22222", LARK_TASKBOARD_PORT: "11111" },
    ])
      expect(normalizeCodexBoardEnvironment(input)).toEqual({ CODEXBOARD_PORT: "22222" });
    expect(
      normalizeCodexBoardEnvironment({ LARK_CODEX_PORT: "", LARK_TASKBOARD_PORT: "11111" }),
    ).toEqual({ CODEXBOARD_PORT: "" });
  });

  it("normalizes legacy settings without mutating callers or unrelated variables", () => {
    const input = { LARK_TASKBOARD_PORT: "12345", OTHER: "unchanged" };
    expect(normalizeCodexBoardEnvironment(input)).toEqual({
      CODEXBOARD_PORT: "12345",
      OTHER: "unchanged",
    });
    expect(input.LARK_TASKBOARD_PORT).toBe("12345");
  });

  it("gives explicitly configured new values priority, including empty strings", () => {
    expect(
      normalizeCodexBoardEnvironment({
        CODEXBOARD_PORT: "47823",
        LARK_TASKBOARD_PORT: "12345",
        CODEXBOARD_AUTH_FILE: "",
        LARK_TASKBOARD_AUTH_FILE: "/old/auth",
      }),
    ).toEqual({ CODEXBOARD_PORT: "47823", CODEXBOARD_AUTH_FILE: "" });
  });
});
