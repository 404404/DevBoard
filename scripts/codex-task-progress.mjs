import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import Database from "better-sqlite3";

const cache = new Map();
export function parseTaskProgress(contents) {
  const lines = contents.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const { payload } = JSON.parse(lines[i]);
      if (!["function_call", "custom_tool_call"].includes(payload?.type)) continue;
      const input = payload.arguments ?? payload.input;
      if (typeof input !== "string") continue;
      let statuses;
      if (payload.name === "update_plan") {
        const plan = JSON.parse(input).plan;
        if (!Array.isArray(plan) || !plan.length) continue;
        statuses = plan.map((step) => step?.status);
      } else if (payload.name === "exec") {
        // Match only the plan literal in a named update_plan call. Never execute tool input.
        const calls = [
          ...input.matchAll(/tools\.update_plan\s*\(\s*\{[^]*?\bplan\s*:\s*\[([^]*?)\]/g),
        ];
        if (!calls.length) continue;
        statuses = [
          ...calls
            .at(-1)[1]
            .matchAll(/["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']/g),
        ].map((match) => match[1]);
      } else continue;
      if (
        !statuses.length ||
        statuses.some((s) => !["completed", "in_progress", "pending"].includes(s))
      )
        continue;
      return {
        completed: statuses.filter((s) => s === "completed").length,
        total: statuses.length,
      };
    } catch {
      /* A concurrent append can leave a partial record. */
    }
  }
  return null;
}

export async function readTaskProgress(home, { threadId } = {}) {
  if (
    !isAbsolute(home ?? "") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId ?? "")
  )
    throw new Error("Invalid task progress query");
  let db;
  try {
    const name = (await readdir(home))
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    if (!name) return null;
    db = new Database(join(home, name), { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId);
    if (!row?.rollout_path) return null;
    const path = await realpath(row.rollout_path);
    const root = await realpath(home);
    if (
      !["sessions", "archived_sessions"].some((dir) => {
        const rel = relative(join(root, dir), path);
        return rel && !rel.startsWith("..") && !isAbsolute(rel);
      })
    )
      return null;
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      const previous = cache.get(path);
      if (previous?.size === info.size && previous.mtime === info.mtimeMs) return previous.value;
      const length = Math.min(info.size, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
      let contents = buffer.subarray(0, bytesRead).toString("utf8");
      if (length < info.size) contents = contents.slice(contents.indexOf("\n") + 1);
      const value = parseTaskProgress(contents);
      cache.set(path, { size: info.size, mtime: info.mtimeMs, value });
      if (cache.size > 256) cache.delete(cache.keys().next().value);
      return value;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
