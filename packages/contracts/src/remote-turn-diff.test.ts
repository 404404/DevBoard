import { expect, it } from "vitest";
import { remoteTurnDiff } from "./remote-turn-diff.js";

it("reconstructs Desktop fileChange hunks and retains repeated edits", () => {
  const item = (diff: string, status = "completed") => ({
    type: "fileChange",
    status,
    changes: [{ path: "/repo/a.ts", kind: { type: "update", move_path: null }, diff }],
  });
  const diff = remoteTurnDiff(
    {
      diff: null,
      items: [
        item("@@ -1 +1 @@\n-old\n+new\n"),
        item("@@ -2 +2 @@\n-before\n+after\n"),
        item("+rejected", "declined"),
        item("+pending", "inProgress"),
      ],
    },
    "/repo",
  );
  expect(diff).toContain('diff --git "a/a.ts" "b/a.ts"');
  expect(diff.match(/^diff --git /gm)).toHaveLength(1);
  expect(diff).toContain("+new\n");
  expect(diff).toContain("+after\n");
  expect(diff).not.toMatch(/rejected|pending/);
});

it("prefers published turn diff and wraps new file contents", () => {
  expect(remoteTurnDiff({ diff: "published", items: [] }, "/repo")).toBe("published");
  expect(
    remoteTurnDiff(
      {
        items: [
          {
            type: "fileChange",
            status: "completed",
            changes: [{ path: "/repo/new.txt", kind: { type: "add" }, diff: "hello\nworld\n" }],
          },
        ],
      },
      "/repo",
    ),
  ).toContain("@@ -0,0 +1,2 @@\n+hello\n+world\n");
});
