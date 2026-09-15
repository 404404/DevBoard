import { type CreateTaskRelationCommand } from "@codexboard/contracts";

import { AppError } from "../../app-error.js";
import { type SqliteDatabase } from "../database/index.js";

export type TaskRelationDirection = CreateTaskRelationCommand["relationType"];

export interface NormalizedTaskRelation {
  readonly type: "parent" | "blocks" | "related";
  readonly sourceTaskId: string;
  readonly targetTaskId: string;
}

interface InsertTaskRelationOptions extends NormalizedTaskRelation {
  readonly id: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export function normalizeTaskRelation(
  taskId: string,
  targetTaskId: string,
  direction: TaskRelationDirection,
): NormalizedTaskRelation {
  if (direction === "parent") {
    return { type: "parent", sourceTaskId: targetTaskId, targetTaskId: taskId };
  }
  if (direction === "child") {
    return { type: "parent", sourceTaskId: taskId, targetTaskId };
  }
  if (direction === "blocked_by") {
    return { type: "blocks", sourceTaskId: targetTaskId, targetTaskId: taskId };
  }
  if (direction === "blocks") {
    return { type: "blocks", sourceTaskId: taskId, targetTaskId };
  }
  return taskId.localeCompare(targetTaskId) < 0
    ? { type: "related", sourceTaskId: taskId, targetTaskId }
    : { type: "related", sourceTaskId: targetTaskId, targetTaskId: taskId };
}

export function insertTaskRelation(
  database: SqliteDatabase,
  options: InsertTaskRelationOptions,
): void {
  const duplicate = database
    .prepare(
      `SELECT 1 FROM task_relations
      WHERE type = ? AND source_task_id = ? AND target_task_id = ?`,
    )
    .get(options.type, options.sourceTaskId, options.targetTaskId);
  if (duplicate) {
    throw new AppError("DUPLICATE_REQUEST", 409, "任务关系已存在");
  }
  if (options.type === "parent") {
    if (
      database
        .prepare("SELECT 1 FROM task_relations WHERE type = 'parent' AND target_task_id = ?")
        .get(options.targetTaskId)
    ) {
      throw new AppError("INVALID_REQUEST", 409, "子任务已有父任务");
    }
    if (wouldCreateParentCycle(database, options.sourceTaskId, options.targetTaskId)) {
      throw new AppError("INVALID_REQUEST", 409, "父子关系会形成循环");
    }
  }

  try {
    database
      .prepare(
        `INSERT INTO task_relations (
          id, project_id, type, source_task_id, target_task_id, created_by_identity_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.id,
        options.projectId,
        options.type,
        options.sourceTaskId,
        options.targetTaskId,
        options.createdBy,
        options.createdAt,
      );
  } catch (cause: unknown) {
    if ((cause as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new AppError("DUPLICATE_REQUEST", 409, "任务关系已存在", { cause });
    }
    throw cause;
  }
}

export function wouldCreateParentCycle(
  database: SqliteDatabase,
  parentTaskId: string,
  childTaskId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT target_task_id FROM task_relations WHERE type = 'parent' AND source_task_id = ?
          UNION
          SELECT relations.target_task_id
          FROM task_relations AS relations
          JOIN descendants ON descendants.id = relations.source_task_id
          WHERE relations.type = 'parent'
        )
        SELECT 1 FROM descendants WHERE id = ? LIMIT 1`,
      )
      .get(childTaskId, parentTaskId),
  );
}
