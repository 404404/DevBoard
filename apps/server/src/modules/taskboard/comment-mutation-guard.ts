import { hasActiveDesktopTurn } from "./desktop-execution-state.js";
import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";

export function assertCommentsMutable(database: SqliteDatabase, taskId: string): void {
  const active = database
    .prepare(
      `SELECT 1 FROM jobs WHERE task_id = ?
    AND status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'canceling') LIMIT 1`,
    )
    .get(taskId);
  if (active || hasActiveDesktopTurn(database, taskId))
    throw new AppError("INVALID_REQUEST", 409, "任务执行中，不能修改或删除评论及其附件");
}
