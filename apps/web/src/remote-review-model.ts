import type { RemoteReviewFile } from "@lark-codex/contracts";
import { parseRemoteDiff, type RemoteDiffLine } from "./remote-diff";

export interface ReviewHunk {
  label: string;
  added: number;
  removed: number;
  lines: RemoteDiffLine[];
}
export function reviewHunks(patch: string): ReviewHunk[] {
  const hunks: ReviewHunk[] = [];
  for (const file of parseRemoteDiff(patch)) {
    let hunk: ReviewHunk | undefined;
    for (const line of file.lines) {
      const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line.text);
      if (range) {
        const count = Number(range[4] ?? 1) || Number(range[2] ?? 1);
        const start = Number(range[4] ?? 1) ? Number(range[3]) : Number(range[1]);
        hunk = {
          label: count > 1 ? `第 ${start}–${start + count - 1} 行` : `第 ${start} 行`,
          added: 0,
          removed: 0,
          lines: [],
        };
        hunks.push(hunk);
      } else if (hunk && (line.kind !== "metadata" || line.text.startsWith("\\ No newline"))) {
        hunk.lines.push(line);
        if (line.kind === "addition") hunk.added++;
        if (line.kind === "deletion") hunk.removed++;
      }
    }
  }
  return hunks;
}
export interface ReviewTree {
  name: string;
  path: string;
  file?: RemoteReviewFile;
  children: ReviewTree[];
}
export function reviewTree(files: RemoteReviewFile[]) {
  const roots: ReviewTree[] = [];
  for (const file of files) {
    let children = roots;
    const parts = file.path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/");
      let node = children.find((node) => node.path === path);
      if (!node) {
        node = { name: parts[index]!, path, children: [] };
        children.push(node);
      }
      if (index === parts.length - 1) node.file = file;
      children = node.children;
    }
  }
  const sort = (nodes: ReviewTree[]) => {
    nodes.sort(
      (a, b) =>
        Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name, "zh-CN"),
    );
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}
