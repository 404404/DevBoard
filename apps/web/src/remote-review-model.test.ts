import { expect, it } from "vitest";
import { reviewHunks, reviewTree } from "./remote-review-model";

it("groups only hunk content, preserving source numbers and deletion-only ranges", () => {
  const hunks = reviewHunks(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,3 @@\n-old\n+++ b/in-code\n+new\n same\n@@ -20,2 +21,0 @@\n-gone\n-also gone\n",
  );
  expect(hunks.map((hunk) => [hunk.label, hunk.added, hunk.removed])).toEqual([
    ["第 2–4 行", 2, 1],
    ["第 20–21 行", 0, 2],
  ]);
  expect(hunks[0]?.lines.map((line) => line.text)).toEqual([
    "-old",
    "+++ b/in-code",
    "+new",
    " same",
  ]);
  expect(hunks[1]?.lines[0]?.oldLine).toBe(20);
});
it("builds directories before files and keeps full paths for duplicate basenames", () => {
  const files = ["README.md", "apps/b/a.ts", "apps/a.ts"].map((path) => ({
    path,
    previousPath: null,
    status: "unchanged" as const,
    added: 0,
    removed: 0,
    binary: false,
  }));
  const tree = reviewTree(files);
  expect(tree.map((node) => node.name)).toEqual(["apps", "README.md"]);
  expect(tree[0]?.children.map((node) => node.path)).toEqual(["apps/b", "apps/a.ts"]);
  expect(tree[0]?.children[0]?.children[0]?.file?.path).toBe("apps/b/a.ts");
});
