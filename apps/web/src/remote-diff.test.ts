import { describe, expect, it } from "vitest";
import { parseRemoteDiff } from "./remote-diff";

describe("Remote changed-files presentation", () => {
  it("separates files and counts code lines without counting diff headers", () => {
    const files = parseRemoteDiff(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +10,2 @@\n-old\n+++counter\n same\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted",
    );
    expect(files.map(({ path, added, removed }) => ({ path, added, removed }))).toEqual([
      { path: "a.ts", added: 1, removed: 1 },
      { path: "b.ts", added: 0, removed: 1 },
    ]);
    expect(files[0]?.lines.find((line) => line.text === "+++counter")).toMatchObject({
      kind: "addition",
      newLine: 10,
    });
    expect(files[0]?.lines.find((line) => line.text === " same")).toMatchObject({
      oldLine: 11,
      newLine: 11,
    });
  });

  it("preserves non-unified output and rename-only metadata", () => {
    const text = "Binary files a/image.png and b/image.png differ";
    expect(
      parseRemoteDiff(text)[0]
        ?.lines.map((line) => line.text)
        .join("\n"),
    ).toBe(text);
    const renamed = parseRemoteDiff(
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts",
    );
    expect(renamed[0]).toMatchObject({ path: "new.ts", added: 0, removed: 0 });
    expect(
      parseRemoteDiff(
        "diff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ",
      )[0]?.path,
    ).toBe("icon.png");
  });

  it("uses the destination filename for additions and retains quoted paths", () => {
    const files = parseRemoteDiff(
      'diff --git "a/a b.ts" "b/a b.ts"\n--- /dev/null\n+++ "b/a b.ts"\n@@ -0,0 +1 @@\n+new',
    );
    expect(files[0]).toMatchObject({ path: "a b.ts", added: 1, removed: 0 });
    expect(parseRemoteDiff("")).toEqual([]);
  });
});
