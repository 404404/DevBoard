import type Database from "better-sqlite3";

import { allocateProjectKey, formatTaskIdentifier } from "../../project-sync/project-key.js";

export const PROJECT_KEY_FORMAT_SQL = `
DROP TRIGGER projects_sync_shape_insert;
DROP TRIGGER projects_sync_shape_update;

CREATE TABLE projects_v7 (
  id TEXT PRIMARY KEY,
  project_key TEXT COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workspace_realpath TEXT UNIQUE,
  next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT REFERENCES actors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT,
  source_kind TEXT NOT NULL DEFAULT 'legacy'
    CHECK (source_kind IN ('legacy', 'codex', 'system')),
  system_kind TEXT CHECK (system_kind IS NULL OR system_kind IN ('all', 'temporary')),
  codex_project_id TEXT,
  root_paths_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(root_paths_json) AND json_type(root_paths_json) = 'array'),
  sync_position INTEGER CHECK (sync_position IS NULL OR sync_position >= 0),
  sync_deleted_at TEXT
) STRICT;

INSERT INTO projects_v7 (
  id, project_key, name, description, workspace_realpath, next_task_number, version,
  created_by, created_at, updated_at, archived_at, source_kind, system_kind,
  codex_project_id, root_paths_json, sync_position, sync_deleted_at
)
SELECT
  id, project_key, name, description, workspace_realpath, next_task_number, version,
  created_by, created_at, updated_at, archived_at, source_kind, system_kind,
  codex_project_id, root_paths_json, sync_position, sync_deleted_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_v7 RENAME TO projects;
`;

const PROJECT_TRIGGER_SQL = `
CREATE UNIQUE INDEX projects_codex_project_id_idx
  ON projects(codex_project_id)
  WHERE codex_project_id IS NOT NULL;

CREATE TRIGGER projects_sync_shape_insert
BEFORE INSERT ON projects
WHEN CASE NEW.source_kind
  WHEN 'legacy' THEN
    NEW.system_kind IS NOT NULL OR NEW.codex_project_id IS NOT NULL OR NEW.sync_position IS NOT NULL
      OR NEW.sync_deleted_at IS NOT NULL
  WHEN 'codex' THEN
    NEW.system_kind IS NOT NULL OR NEW.codex_project_id IS NULL OR NEW.sync_position IS NULL
      OR json_array_length(NEW.root_paths_json) = 0
  WHEN 'system' THEN
    NEW.system_kind IS NULL OR NEW.codex_project_id IS NOT NULL OR NEW.sync_position IS NOT NULL
      OR NEW.sync_deleted_at IS NOT NULL OR json_array_length(NEW.root_paths_json) != 0
  ELSE 1
END
BEGIN
  SELECT RAISE(ABORT, 'invalid project sync shape');
END;

CREATE TRIGGER projects_sync_shape_update
BEFORE UPDATE OF source_kind, system_kind, codex_project_id, root_paths_json, sync_position, sync_deleted_at
ON projects
WHEN CASE NEW.source_kind
  WHEN 'legacy' THEN
    NEW.system_kind IS NOT NULL OR NEW.codex_project_id IS NOT NULL OR NEW.sync_position IS NOT NULL
      OR NEW.sync_deleted_at IS NOT NULL
  WHEN 'codex' THEN
    NEW.system_kind IS NOT NULL OR NEW.codex_project_id IS NULL OR NEW.sync_position IS NULL
      OR json_array_length(NEW.root_paths_json) = 0
  WHEN 'system' THEN
    NEW.system_kind IS NULL OR NEW.codex_project_id IS NOT NULL OR NEW.sync_position IS NOT NULL
      OR NEW.sync_deleted_at IS NOT NULL OR json_array_length(NEW.root_paths_json) != 0
  ELSE 1
END
BEGIN
  SELECT RAISE(ABORT, 'invalid project sync shape');
END;

CREATE TRIGGER projects_key_shape_insert
BEFORE INSERT ON projects
WHEN CASE
  WHEN NEW.source_kind = 'system' AND NEW.system_kind = 'all' THEN NEW.project_key IS NOT NULL
  WHEN NEW.source_kind = 'system' AND NEW.system_kind = 'temporary' THEN
    NEW.project_key IS NULL OR (NEW.project_key COLLATE BINARY) != 'TEMP'
  WHEN NEW.source_kind = 'codex' THEN
    NEW.project_key IS NULL OR length(NEW.project_key) NOT BETWEEN 1 AND 5
      OR NEW.project_key GLOB '*[^A-Z]*'
  ELSE NEW.project_key IS NULL
END
BEGIN
  SELECT RAISE(ABORT, 'invalid project key shape');
END;

CREATE TRIGGER projects_key_shape_update
BEFORE UPDATE OF project_key, source_kind, system_kind ON projects
WHEN CASE
  WHEN NEW.source_kind = 'system' AND NEW.system_kind = 'all' THEN NEW.project_key IS NOT NULL
  WHEN NEW.source_kind = 'system' AND NEW.system_kind = 'temporary' THEN
    NEW.project_key IS NULL OR (NEW.project_key COLLATE BINARY) != 'TEMP'
  WHEN NEW.source_kind = 'codex' THEN
    NEW.project_key IS NULL OR length(NEW.project_key) NOT BETWEEN 1 AND 5
      OR NEW.project_key GLOB '*[^A-Z]*'
  ELSE NEW.project_key IS NULL
END
BEGIN
  SELECT RAISE(ABORT, 'invalid project key shape');
END;
`;

interface ProjectRow {
  readonly id: string;
  readonly projectKey: string | null;
  readonly sourceKind: "legacy" | "codex" | "system";
  readonly systemKind: "all" | "temporary" | null;
  readonly rootPathsJson: string;
  readonly syncDeletedAt: string | null;
}

interface TaskRow {
  readonly id: string;
  readonly identifier: string;
  readonly projectId: string;
  readonly taskNumber: number;
}

interface OrphanRow {
  readonly taskId: string;
  readonly sourceProjectId: string;
  readonly sourceTaskNumber: number;
}

function primaryRoot(project: ProjectRow): string {
  const roots: unknown = JSON.parse(project.rootPathsJson);
  if (!Array.isArray(roots) || typeof roots[0] !== "string") {
    throw new Error(`Codex 项目 ${project.id} 缺少主根目录`);
  }
  return roots[0];
}

export function migrateProjectKeyFormat(database: Database.Database): void {
  const projects = database
    .prepare(
      `SELECT id, project_key AS projectKey, source_kind AS sourceKind,
        system_kind AS systemKind, root_paths_json AS rootPathsJson,
        sync_deleted_at AS syncDeletedAt
      FROM projects ORDER BY created_at, id`,
    )
    .all() as ProjectRow[];
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const legacyKeys = new Map(
    projects
      .filter((project) => project.sourceKind === "legacy" && project.projectKey)
      .map((project) => [project.id, project.projectKey as string]),
  );
  const occupied = new Set(["TEMP", ...legacyKeys.values()].map((key) => key.toUpperCase()));
  const projectKeys = new Map<string, string | null>();

  database.prepare("UPDATE projects SET project_key = NULL").run();
  const updateProjectKey = database.prepare("UPDATE projects SET project_key = ? WHERE id = ?");
  for (const project of projects) {
    if (project.sourceKind === "system") {
      const key = project.systemKind === "temporary" ? "TEMP" : null;
      updateProjectKey.run(key, project.id);
      projectKeys.set(project.id, key);
      continue;
    }
    if (project.sourceKind === "legacy") {
      const key = legacyKeys.get(project.id) as string;
      updateProjectKey.run(key, project.id);
      projectKeys.set(project.id, key);
      continue;
    }
    const key = allocateProjectKey(primaryRoot(project), occupied);
    occupied.add(key);
    updateProjectKey.run(key, project.id);
    projectKeys.set(project.id, key);
  }

  const orphans = new Map(
    (
      database
        .prepare(
          `SELECT task_id AS taskId, source_project_id AS sourceProjectId,
            source_task_number AS sourceTaskNumber
          FROM project_orphaned_tasks`,
        )
        .all() as OrphanRow[]
    ).map((orphan) => [orphan.taskId, orphan]),
  );
  const tasks = database
    .prepare("SELECT id, identifier, project_id AS projectId, task_number AS taskNumber FROM tasks")
    .all() as TaskRow[];
  const identifiers = new Map<string, string>();
  const seenIdentifiers = new Set<string>();
  for (const task of tasks) {
    const project = projectsById.get(task.projectId);
    if (!project) throw new Error(`任务 ${task.id} 缺少项目`);
    const orphan = orphans.get(task.id);
    if (orphan && !(project.sourceKind === "system" && project.systemKind === "temporary")) {
      throw new Error(`孤儿任务 ${task.id} 不在临时项目`);
    }
    let identifier = task.identifier;
    if (project.sourceKind === "codex") {
      identifier = formatTaskIdentifier(projectKeys.get(project.id) as string, task.taskNumber);
    } else if (project.sourceKind === "system" && project.systemKind === "temporary") {
      if (orphan) {
        const sourceProject = projectsById.get(orphan.sourceProjectId);
        const sourceKey = projectKeys.get(orphan.sourceProjectId);
        if (
          sourceProject?.sourceKind !== "codex" ||
          !sourceProject.syncDeletedAt ||
          typeof sourceKey !== "string"
        ) {
          throw new Error(`孤儿任务 ${task.id} 缺少有效的 Codex 来源项目`);
        }
        identifier = formatTaskIdentifier(sourceKey, orphan.sourceTaskNumber);
      } else {
        identifier = formatTaskIdentifier("TEMP", task.taskNumber);
      }
    } else if (project.sourceKind === "system") {
      throw new Error(`全部项目不能承载任务 ${task.id}`);
    }
    const folded = identifier.toUpperCase();
    if (seenIdentifiers.has(folded)) throw new Error(`任务标识符冲突：${identifier}`);
    seenIdentifiers.add(folded);
    identifiers.set(task.id, identifier);
  }

  const updateIdentifier = database.prepare("UPDATE tasks SET identifier = ? WHERE id = ?");
  for (const task of tasks) updateIdentifier.run(`__PROJECT_KEY_V7__${task.id}`, task.id);
  for (const task of tasks) updateIdentifier.run(identifiers.get(task.id), task.id);

  database.exec(PROJECT_TRIGGER_SQL);
}

export const PROJECT_KEY_FORMAT_TRANSFORM_CHECKSUM = "project-key-format-transform-v1";
