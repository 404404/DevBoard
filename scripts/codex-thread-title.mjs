import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Codex's title API persists names separately from rollouts. Reading this index
// neither loads a thread nor acquires its writer lock.
export async function readCodexThreadTitle(codexHome, threadId) {
  let contents;
  try {
    contents = await readFile(join(codexHome, "session_index.jsonl"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (
        entry.id === threadId &&
        typeof entry.thread_name === "string" &&
        entry.thread_name.trim()
      )
        return entry.thread_name.trim();
    } catch {
      // An append may be in progress; a partial line is not an authoritative title.
    }
  }
  return null;
}
