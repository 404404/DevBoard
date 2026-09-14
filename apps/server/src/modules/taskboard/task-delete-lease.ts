import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";
import { assertTaskLifecycleAvailable } from "./task-lifecycle-guard.js";

export function assertTaskDeletionAvailable(database: SqliteDatabase, taskId: string): void {
  assertTaskLifecycleAvailable(database, taskId);
  const deleting = database
    .prepare("SELECT 1 FROM task_delete_leases WHERE task_id = ?")
    .get(taskId);
  if (deleting) {
    throw new AppError("VERSION_CONFLICT", 409, "任务正在删除，请稍后重试");
  }
}
