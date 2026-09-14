export interface RemoteDiffLine {
  text: string;
  kind: "addition" | "deletion" | "context" | "metadata";
  oldLine?: number;
  newLine?: number;
}
export interface RemoteDiffFile {
  path: string;
  added: number;
  removed: number;
  lines: RemoteDiffLine[];
}

function filename(value: string) {
  let path = value.split("\t")[0] ?? value;
  if (path.startsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
      /* Retain unrecognized quoted filenames. */
    }
  }
  return path.replace(/^[ab]\//, "");
}

// Presentation only: retain every source line, including binary/rename metadata.
export function parseRemoteDiff(diff: string): RemoteDiffFile[] {
  if (!diff) return [];
  return diff
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((chunk) => {
      const file: RemoteDiffFile = { path: "代码改动", added: 0, removed: 0, lines: [] };
      let inHunk = false;
      let oldLine = 0;
      let newLine = 0;
      for (const text of chunk.split("\n")) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (hunk) {
          inHunk = true;
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
        }
        if (!inHunk) {
          const header = /^diff --git ("(?:[^"\\]|\\.)*"|.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(text);
          if (header) file.path = filename(header[2]!);
          if (text.startsWith("--- ") && file.path === "代码改动" && text !== "--- /dev/null")
            file.path = filename(text.slice(4));
          if (text.startsWith("+++ ") && text !== "+++ /dev/null")
            file.path = filename(text.slice(4));
          if (text.startsWith("rename to ")) file.path = text.slice(10);
        }
        if (inHunk && text.startsWith("+")) {
          file.added++;
          file.lines.push({ text, kind: "addition", newLine: newLine++ });
        } else if (inHunk && text.startsWith("-")) {
          file.removed++;
          file.lines.push({ text, kind: "deletion", oldLine: oldLine++ });
        } else if (inHunk && text.startsWith(" ")) {
          file.lines.push({ text, kind: "context", oldLine: oldLine++, newLine: newLine++ });
        } else file.lines.push({ text, kind: "metadata" });
      }
      return file;
    });
}
