import { expect, it } from "vitest";
import { readCodexBoardStorage } from "./brand-storage";

it("preserves both generations of browser preferences without overriding empty current values", () => {
  const values = new Map<string, string>([["lark-taskboard:view", "oldest"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  expect(readCodexBoardStorage(storage, "view")).toBe("oldest");
  values.set("lark-codex:view", "previous");
  expect(readCodexBoardStorage(storage, "view")).toBe("previous");
  values.set("codexboard:view", "");
  expect(readCodexBoardStorage(storage, "view")).toBe("");
});
