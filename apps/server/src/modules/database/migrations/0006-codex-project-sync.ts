export const CODEX_PROJECT_SYNC_SQL = `
ALTER TABLE projects ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK (source_kind IN ('legacy', 'codex', 'system'));
ALTER TABLE projects ADD COLUMN system_kind TEXT
  CHECK (system_kind IS NULL OR system_kind IN ('all', 'temporary'));
ALTER TABLE projects ADD COLUMN codex_project_id TEXT;
ALTER TABLE projects ADD COLUMN root_paths_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(root_paths_json) AND json_type(root_paths_json) = 'array');
ALTER TABLE projects ADD COLUMN sync_position INTEGER
  CHECK (sync_position IS NULL OR sync_position >= 0);
ALTER TABLE projects ADD COLUMN sync_deleted_at TEXT;

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

CREATE TABLE project_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  status TEXT NOT NULL DEFAULT 'stale' CHECK (status IN ('synced', 'stale')),
  snapshot_schema_version INTEGER CHECK (snapshot_schema_version IS NULL OR snapshot_schema_version > 0),
  snapshot_generated_at TEXT,
  snapshot_sha256 TEXT CHECK (snapshot_sha256 IS NULL OR length(snapshot_sha256) = 64),
  project_count INTEGER NOT NULL DEFAULT 0 CHECK (project_count >= 0),
  last_success_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 120),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO project_sync_state (singleton) VALUES (1);

CREATE TABLE project_orphaned_tasks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_task_number INTEGER NOT NULL CHECK (source_task_number > 0),
  orphaned_at TEXT NOT NULL,
  UNIQUE (source_project_id, source_task_number)
) STRICT;

CREATE INDEX project_orphaned_tasks_source_project_idx
  ON project_orphaned_tasks(source_project_id, source_task_number);

INSERT INTO projects (
  id, project_key, name, description, source_kind, system_kind, root_paths_json
) VALUES (
  '00000000-0000-4000-8000-0000000000a1',
  'SYS-ALL',
  '全部项目',
  '聚合当前用户有权访问的所有项目任务',
  'system',
  'all',
  '[]'
);

INSERT INTO projects (
  id, project_key, name, description, source_kind, system_kind, root_paths_json
) VALUES (
  '00000000-0000-4000-8000-0000000000a2',
  'SYS-TEMP',
  '临时项目',
  '保存已从 Codex Desktop 删除项目的历史任务',
  'system',
  'temporary',
  '[]'
);
`;
