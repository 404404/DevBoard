import { createHash, randomUUID } from "node:crypto";

import {
  ALL_PROJECT_ID,
  TEMPORARY_PROJECT_ID,
  type ProjectSyncState,
} from "@lark-taskboard/contracts";
import { z } from "zod";

import { withTransaction, type SqliteDatabase } from "../database/index.js";
import {
  CodexProjectSnapshotSchema,
  type CodexProjectSnapshot,
  type CodexProjectSnapshotEntry,
} from "./codex-project-snapshot.js";
import { allocateProjectKey, formatTaskIdentifier } from "./project-key.js";

const ProjectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceRealpath: z.string().nullable(),
  rootPathsJson: z.string(),
  syncPosition: z.number().int().nullable(),
  syncDeletedAt: z.string().nullable(),
});

const OrphanTaskRowSchema = z.object({
  taskId: z.string(),
  sourceTaskNumber: z.number().int().positive(),
});

const SyncStateRowSchema = z.object({
  status: z.enum(["synced", "stale"]),
  snapshotGeneratedAt: z.string().nullable(),
  snapshotSha256: z.string().nullable(),
  projectCount: z.number().int().nonnegative(),
  lastSuccessAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  updatedAt: z.string(),
});

export interface ProjectSyncStatus {
  readonly status: ProjectSyncState;
  readonly snapshotGeneratedAt: string | null;
  readonly snapshotSha256: string | null;
  readonly projectCount: number;
  readonly lastSuccessAt: string | null;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

export interface ProjectSyncResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly restored: number;
  readonly revision: number | null;
}

interface ProjectSyncServiceOptions {
  readonly database: SqliteDatabase;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
}

function primaryRoot(entry: CodexProjectSnapshotEntry): string {
  const root = entry.rootPaths[0];
  if (!root) throw new Error("Codex 项目缺少主目录");
  return root;
}

export class ProjectSyncService {
  readonly #database: SqliteDatabase;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;

  constructor(options: ProjectSyncServiceOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
  }

  reconcile(input: CodexProjectSnapshot): ProjectSyncResult {
    const snapshot = CodexProjectSnapshotSchema.parse(input);
    const timestamp = this.#now().toISOString();
    const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const result = withTransaction(this.#database, () => {
      this.#database.pragma("defer_foreign_keys = ON");
      let created = 0;
      let updated = 0;
      let deleted = 0;
      let restored = 0;
      let revision: number | null = null;
      const visibleIds = new Set(snapshot.projects.map((project) => project.codexProjectId));

      for (const entry of snapshot.projects) {
        const existing = this.#projectByCodexId(entry.codexProjectId);
        if (existing) {
          if (existing.syncDeletedAt) {
            this.#restoreProject(existing.id, entry, timestamp);
            restored += 1;
            revision = this.#recordProjectChange(existing.id, "project.sync_restored", timestamp);
          } else if (this.#projectChanged(existing, entry)) {
            this.#updateProject(existing.id, entry, timestamp);
            updated += 1;
            revision = this.#recordProjectChange(existing.id, "project.sync_updated", timestamp);
          }
          continue;
        }

        const legacyId = this.#adoptableLegacyProject(primaryRoot(entry));
        const projectId = legacyId ?? randomUUID();
        if (legacyId) {
          this.#updateLegacyProject(legacyId, entry, timestamp);
          updated += 1;
          revision = this.#recordProjectChange(projectId, "project.sync_adopted", timestamp);
        } else {
          this.#createProject(projectId, entry, timestamp);
          created += 1;
          revision = this.#recordProjectChange(projectId, "project.sync_created", timestamp);
        }
      }

      const activeProjects = this.#database
        .prepare(
          `SELECT id, codex_project_id AS codexProjectId
          FROM projects
          WHERE source_kind = 'codex' AND sync_deleted_at IS NULL`,
        )
        .all() as { id: string; codexProjectId: string }[];
      for (const project of activeProjects) {
        if (visibleIds.has(project.codexProjectId)) continue;
        this.#deleteProject(project.id, timestamp);
        deleted += 1;
        revision = this.#recordProjectChange(project.id, "project.sync_deleted", timestamp);
      }

      this.#database
        .prepare(
          `UPDATE project_sync_state SET
            status = 'synced',
            snapshot_schema_version = ?,
            snapshot_generated_at = ?,
            snapshot_sha256 = ?,
            project_count = ?,
            last_success_at = ?,
            last_error_code = NULL,
            updated_at = ?
          WHERE singleton = 1`,
        )
        .run(
          snapshot.schemaVersion,
          snapshot.generatedAt,
          digest,
          snapshot.projects.length,
          timestamp,
          timestamp,
        );
      return { created, updated, deleted, restored, revision };
    });
    if (result.revision !== null) this.#onRevisionCommitted?.(result.revision);
    return result;
  }

  recordFailure(code: string): void {
    const safeCode = /^[A-Z][A-Z0-9_]{2,119}$/.test(code) ? code : "PROJECT_SYNC_FAILED";
    const timestamp = this.#now().toISOString();
    this.#database
      .prepare(
        `UPDATE project_sync_state SET
          status = 'stale', last_error_code = ?, updated_at = ?
        WHERE singleton = 1`,
      )
      .run(safeCode, timestamp);
  }

  status(): ProjectSyncStatus {
    return SyncStateRowSchema.parse(
      this.#database
        .prepare(
          `SELECT status,
            snapshot_generated_at AS snapshotGeneratedAt,
            snapshot_sha256 AS snapshotSha256,
            project_count AS projectCount,
            last_success_at AS lastSuccessAt,
            last_error_code AS lastErrorCode,
            updated_at AS updatedAt
          FROM project_sync_state WHERE singleton = 1`,
        )
        .get(),
    );
  }

  #projectByCodexId(codexProjectId: string) {
    const row = this.#database
      .prepare(
        `SELECT id, name, workspace_realpath AS workspaceRealpath,
          root_paths_json AS rootPathsJson, sync_position AS syncPosition,
          sync_deleted_at AS syncDeletedAt
        FROM projects WHERE codex_project_id = ?`,
      )
      .get(codexProjectId);
    return row ? ProjectRowSchema.parse(row) : null;
  }

  #adoptableLegacyProject(primaryRoot: string): string | null {
    return (
      (this.#database
        .prepare(
          `SELECT id FROM projects
          WHERE source_kind = 'legacy' AND codex_project_id IS NULL
            AND workspace_realpath = ? AND archived_at IS NULL`,
        )
        .pluck()
        .get(primaryRoot) as string | undefined) ?? null
    );
  }

  #projectChanged(row: z.infer<typeof ProjectRowSchema>, entry: CodexProjectSnapshotEntry) {
    return (
      row.name !== entry.name ||
      row.workspaceRealpath !== primaryRoot(entry) ||
      row.rootPathsJson !== JSON.stringify(entry.rootPaths) ||
      row.syncPosition !== entry.position
    );
  }

  #createProject(projectId: string, entry: CodexProjectSnapshotEntry, timestamp: string): void {
    const key = allocateProjectKey(primaryRoot(entry), this.#occupiedProjectKeys());
    this.#database
      .prepare(
        `INSERT INTO projects (
          id, project_key, name, description, workspace_realpath, source_kind,
          codex_project_id, root_paths_json, sync_position, created_at, updated_at
        ) VALUES (?, ?, ?, '', ?, 'codex', ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        key,
        entry.name,
        primaryRoot(entry),
        entry.codexProjectId,
        JSON.stringify(entry.rootPaths),
        entry.position,
        timestamp,
        timestamp,
      );
  }

  #updateLegacyProject(
    projectId: string,
    entry: CodexProjectSnapshotEntry,
    timestamp: string,
  ): void {
    const key = allocateProjectKey(primaryRoot(entry), this.#occupiedProjectKeys(projectId));
    this.#database
      .prepare(
        `UPDATE projects SET
          project_key = ?, name = ?, workspace_realpath = ?,
          source_kind = 'codex', codex_project_id = ?,
          root_paths_json = ?, sync_position = ?, version = version + 1, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        key,
        entry.name,
        primaryRoot(entry),
        entry.codexProjectId,
        JSON.stringify(entry.rootPaths),
        entry.position,
        timestamp,
        projectId,
      );
    this.#rewriteProjectTaskIdentifiers(projectId, key);
  }

  #occupiedProjectKeys(excludedProjectId?: string): ReadonlySet<string> {
    const keys = this.#database
      .prepare(
        `SELECT project_key FROM projects
        WHERE project_key IS NOT NULL AND (? IS NULL OR id != ?)`,
      )
      .pluck()
      .all(excludedProjectId ?? null, excludedProjectId ?? null) as string[];
    return new Set(keys);
  }

  #rewriteProjectTaskIdentifiers(projectId: string, key: string): void {
    const tasks = this.#database
      .prepare("SELECT id, task_number AS taskNumber FROM tasks WHERE project_id = ?")
      .all(projectId) as { id: string; taskNumber: number }[];
    const update = this.#database.prepare("UPDATE tasks SET identifier = ? WHERE id = ?");
    for (const task of tasks) update.run(`__PROJECT_KEY_ADOPT__${task.id}`, task.id);
    for (const task of tasks) {
      update.run(formatTaskIdentifier(key, task.taskNumber), task.id);
    }
  }

  #updateProject(projectId: string, entry: CodexProjectSnapshotEntry, timestamp: string): void {
    this.#database
      .prepare(
        `UPDATE projects SET
          name = ?, workspace_realpath = ?, root_paths_json = ?, sync_position = ?,
          version = version + 1, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        entry.name,
        primaryRoot(entry),
        JSON.stringify(entry.rootPaths),
        entry.position,
        timestamp,
        projectId,
      );
  }

  #deleteProject(projectId: string, timestamp: string): void {
    const tasks = this.#database
      .prepare(
        `SELECT id AS taskId, task_number AS sourceTaskNumber
        FROM tasks WHERE project_id = ? ORDER BY task_number`,
      )
      .all(projectId)
      .map((row) => OrphanTaskRowSchema.parse(row));
    let nextTemporaryNumber = this.#database
      .prepare("SELECT next_task_number FROM projects WHERE id = ?")
      .pluck()
      .get(TEMPORARY_PROJECT_ID) as number;
    const insertOrphan = this.#database.prepare(
      `INSERT INTO project_orphaned_tasks (
        task_id, source_project_id, source_task_number, orphaned_at
      ) VALUES (?, ?, ?, ?)`,
    );
    const moveTask = this.#database.prepare(
      `UPDATE tasks SET
        project_id = ?, task_number = ?, development_context_json = NULL,
        version = version + 1, updated_at = ?
      WHERE id = ?`,
    );
    for (const task of tasks) {
      insertOrphan.run(task.taskId, projectId, task.sourceTaskNumber, timestamp);
      moveTask.run(TEMPORARY_PROJECT_ID, nextTemporaryNumber, timestamp, task.taskId);
      nextTemporaryNumber += 1;
    }
    this.#database
      .prepare("UPDATE task_relations SET project_id = ? WHERE project_id = ?")
      .run(TEMPORARY_PROJECT_ID, projectId);
    this.#database
      .prepare("UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?")
      .run(nextTemporaryNumber, timestamp, TEMPORARY_PROJECT_ID);
    this.#database
      .prepare(
        `UPDATE projects SET
          workspace_realpath = NULL, sync_deleted_at = ?, version = version + 1, updated_at = ?
        WHERE id = ?`,
      )
      .run(timestamp, timestamp, projectId);
  }

  #restoreProject(projectId: string, entry: CodexProjectSnapshotEntry, timestamp: string): void {
    const tasks = this.#database
      .prepare(
        `SELECT orphan.task_id AS taskId, orphan.source_task_number AS sourceTaskNumber
        FROM project_orphaned_tasks AS orphan
        JOIN tasks ON tasks.id = orphan.task_id
        WHERE orphan.source_project_id = ? AND tasks.project_id = ?
        ORDER BY orphan.source_task_number`,
      )
      .all(projectId, TEMPORARY_PROJECT_ID)
      .map((row) => OrphanTaskRowSchema.parse(row));
    const restoreTask = this.#database.prepare(
      `UPDATE tasks SET
        project_id = ?, task_number = ?, version = version + 1, updated_at = ?
      WHERE id = ?`,
    );
    for (const task of tasks) {
      restoreTask.run(projectId, task.sourceTaskNumber, timestamp, task.taskId);
    }
    this.#database
      .prepare(
        `UPDATE task_relations SET project_id = ?
        WHERE project_id = ?
          AND source_task_id IN (
            SELECT task_id FROM project_orphaned_tasks WHERE source_project_id = ?
          )
          AND target_task_id IN (
            SELECT task_id FROM project_orphaned_tasks WHERE source_project_id = ?
          )`,
      )
      .run(projectId, TEMPORARY_PROJECT_ID, projectId, projectId);
    this.#database
      .prepare("DELETE FROM project_orphaned_tasks WHERE source_project_id = ?")
      .run(projectId);
    this.#database
      .prepare(
        `UPDATE projects SET
          name = ?, workspace_realpath = ?, root_paths_json = ?, sync_position = ?,
          sync_deleted_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        entry.name,
        primaryRoot(entry),
        JSON.stringify(entry.rootPaths),
        entry.position,
        timestamp,
        projectId,
      );
  }

  #recordProjectChange(projectId: string, eventType: string, timestamp: string): number {
    const result = this.#database
      .prepare(
        `INSERT INTO change_events (
          aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
        ) VALUES ('project', ?, ?, ?, ?)`,
      )
      .run(projectId, eventType, JSON.stringify({ projectId }), timestamp);
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, action, resource_type, resource_id, outcome, safe_metadata_json, created_at
        ) VALUES (?, ?, 'project', ?, 'allowed', '{}', ?)`,
      )
      .run(randomUUID(), eventType, projectId, timestamp);
    return Number(result.lastInsertRowid);
  }
}

export { ALL_PROJECT_ID, TEMPORARY_PROJECT_ID };
