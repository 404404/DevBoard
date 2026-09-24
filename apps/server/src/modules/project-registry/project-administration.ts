import { randomUUID } from "node:crypto";

import {
  LocalProjectViewSchema,
  type ArchiveProjectCommand,
  type CreateProjectCommand,
  type LocalProjectView,
  type UpdateProjectCommand,
} from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";

const ProjectRowSchema = z.object({
  id: z.uuid(),
  projectKey: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["legacy", "codex", "system"]),
  rootPathsJson: z.string(),
  workspaceRealpath: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export class ProjectAdministration {
  readonly #database: SqliteDatabase;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;

  constructor(
    database: SqliteDatabase,
    now: () => Date = () => new Date(),
    onRevisionCommitted?: (revision: number) => void,
  ) {
    this.#database = database;
    this.#now = now;
    this.#onRevisionCommitted = onRevisionCommitted;
  }

  listProjects(): readonly LocalProjectView[] {
    const rows: unknown[] = this.#database
      .prepare(
        `SELECT
          id,
          project_key AS projectKey,
          name,
          description,
          source_kind AS kind,
          root_paths_json AS rootPathsJson,
          workspace_realpath AS workspaceRealpath,
          version,
          created_at AS createdAt,
          updated_at AS updatedAt,
          archived_at AS archivedAt
        FROM projects
        ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, project_key COLLATE NOCASE`,
      )
      .all();

    return rows.map((row) => this.#projectView(row));
  }

  createProject(command: CreateProjectCommand): LocalProjectView {
    const duplicate = this.#database
      .prepare("SELECT 1 FROM projects WHERE project_key = ? COLLATE NOCASE")
      .get(command.projectKey);
    if (duplicate) {
      throw new AppError("DUPLICATE_REQUEST", 409, "项目 Key 已存在");
    }

    const id = randomUUID();
    const timestamp = this.#now().toISOString();

    const revision = withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO projects (
            id, project_key, name, description, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, command.projectKey, command.name, command.description, timestamp, timestamp);
      this.#recordAudit("project.create", id, {
        projectKey: command.projectKey,
      });
      return this.#recordChange(
        "project.created",
        id,
        { projectId: id, projectKey: command.projectKey },
        timestamp,
      );
    });
    this.#onRevisionCommitted?.(revision);

    return this.#readProject(id);
  }

  updateProject(projectId: string, command: UpdateProjectCommand): LocalProjectView {
    const current = this.#readProject(projectId);
    if (current.archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "已归档项目不能编辑");
    }

    const timestamp = this.#now().toISOString();
    const result = withTransaction(this.#database, () => {
      const update = this.#database
        .prepare(
          `UPDATE projects SET
            name = ?,
            description = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ? AND version = ? AND archived_at IS NULL`,
        )
        .run(
          command.name ?? current.name,
          command.description ?? current.description,
          timestamp,
          projectId,
          command.expectedVersion,
        );
      if (update.changes !== 1) {
        return false;
      }

      this.#recordAudit("project.update", projectId, {
        changedFields: [
          ...(command.name === undefined ? [] : ["name"]),
          ...(command.description === undefined ? [] : ["description"]),
        ],
      });
      return this.#recordChange("project.updated", projectId, { projectId }, timestamp);
    });

    if (!result) {
      throw new AppError("VERSION_CONFLICT", 409, "项目版本已变化，请重新加载");
    }
    this.#onRevisionCommitted?.(result);
    return this.#readProject(projectId);
  }

  archiveProject(projectId: string, command: ArchiveProjectCommand): LocalProjectView {
    const current = this.#readProject(projectId);
    if (current.archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "项目已经归档");
    }

    const timestamp = this.#now().toISOString();
    const changed = withTransaction(this.#database, () => {
      const archive = this.#database
        .prepare(
          `UPDATE projects SET
            archived_at = ?,
            updated_at = ?,
            version = version + 1
          WHERE id = ? AND version = ? AND archived_at IS NULL`,
        )
        .run(timestamp, timestamp, projectId, command.expectedVersion);
      if (archive.changes !== 1) {
        return false;
      }

      this.#recordAudit("project.archive", projectId, {});
      return this.#recordChange("project.archived", projectId, { projectId }, timestamp);
    });

    if (!changed) {
      throw new AppError("VERSION_CONFLICT", 409, "项目版本已变化，请重新加载");
    }
    this.#onRevisionCommitted?.(changed);
    return this.#readProject(projectId);
  }

  #readProject(projectId: string): LocalProjectView {
    const row: unknown = this.#database
      .prepare(
        `SELECT
          id,
          project_key AS projectKey,
          name,
          description,
          source_kind AS kind,
          root_paths_json AS rootPathsJson,
          workspace_realpath AS workspaceRealpath,
          version,
          created_at AS createdAt,
          updated_at AS updatedAt,
          archived_at AS archivedAt
        FROM projects
        WHERE id = ?`,
      )
      .get(projectId);
    if (!row) {
      throw new AppError("NOT_FOUND", 404, "项目不存在");
    }
    return this.#projectView(row);
  }

  #projectView(row: unknown): LocalProjectView {
    const project = ProjectRowSchema.parse(row);
    const rootPaths = z.array(z.string().min(1)).parse(JSON.parse(project.rootPathsJson));
    return LocalProjectViewSchema.parse({ ...project, rootPaths });
  }

  #recordAudit(action: string, projectId: string, metadata: Record<string, unknown>): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome, safe_metadata_json
        ) VALUES (?, NULL, ?, 'project', ?, 'allowed', ?)`,
      )
      .run(randomUUID(), action, projectId, JSON.stringify(metadata));
  }

  #recordChange(
    eventType: string,
    projectId: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): number {
    const result = this.#database
      .prepare(
        `INSERT INTO change_events (
          aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
        ) VALUES ('project', ?, ?, ?, ?)`,
      )
      .run(projectId, eventType, JSON.stringify(payload), createdAt);
    return Number(result.lastInsertRowid);
  }
}
