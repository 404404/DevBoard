import type { SqliteDatabase } from "../database/index.js";

export function hasActiveDesktopTurn(database: SqliteDatabase, taskId: string): boolean {
  const row = database
    .prepare(
      `SELECT json_extract(job_events.safe_payload_json, '$.active') AS active
    FROM job_events JOIN jobs ON jobs.id = job_events.job_id
    JOIN task_threads ON task_threads.id = jobs.task_thread_id AND task_threads.is_primary = 1
    WHERE jobs.task_id = ? AND job_events.kind = 'codex.desktop_state'
    ORDER BY job_events.rowid DESC LIMIT 1`,
    )
    .get(taskId) as { active: number } | undefined;
  return Boolean(row?.active);
}
