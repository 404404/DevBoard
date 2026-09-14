import type { TaskStatus } from "@lark-taskboard/contracts";
import { AppError } from "../../app-error.js";

export function assertTaskEditable(task: { readonly status: TaskStatus }): void {
  if (task.status === "done" || task.status === "canceled") {
    throw new AppError("INVALID_REQUEST", 409, "已完成或已取消任务只读，请先恢复任务后再修改");
  }
}
