export const CORE_SCHEMA_SQL = `
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  open_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_key, open_id)
) STRICT;

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX sessions_actor_id_idx ON sessions(actor_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workspace_realpath TEXT UNIQUE,
  next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT REFERENCES actors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT
) STRICT;

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'executor', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, actor_id)
) STRICT;

CREATE INDEX project_members_actor_id_idx ON project_members(actor_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL COLLATE NOCASE UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_number INTEGER NOT NULL CHECK (task_number > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled')
  ),
  priority TEXT NOT NULL DEFAULT 'none' CHECK (
    priority IN ('none', 'urgent', 'high', 'medium', 'low')
  ),
  labels_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(labels_json) AND json_type(labels_json) = 'array'
  ),
  assignee_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  creator_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  start_at TEXT,
  due_at TEXT,
  recurrence_json TEXT CHECK (recurrence_json IS NULL OR json_valid(recurrence_json)),
  development_context_json TEXT CHECK (
    development_context_json IS NULL OR json_valid(development_context_json)
  ),
  sort_order REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT,
  UNIQUE (project_id, task_number),
  UNIQUE (project_id, id)
) STRICT;

CREATE INDEX tasks_project_status_order_idx ON tasks(project_id, status, sort_order);
CREATE INDEX tasks_assignee_actor_id_idx ON tasks(assignee_actor_id);
CREATE INDEX tasks_due_at_idx ON tasks(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE task_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('parent', 'blocks', 'related')),
  source_task_id TEXT NOT NULL,
  target_task_id TEXT NOT NULL,
  created_by TEXT REFERENCES actors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (source_task_id <> target_task_id),
  UNIQUE (type, source_task_id, target_task_id),
  FOREIGN KEY (project_id, source_task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX task_relations_source_idx ON task_relations(source_task_id);
CREATE INDEX task_relations_target_idx ON task_relations(target_task_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (task_id, id)
) STRICT;

CREATE INDEX comments_task_created_idx ON comments(task_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id TEXT,
  uploader_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (task_id, comment_id) REFERENCES comments(task_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX attachments_task_id_idx ON attachments(task_id);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX activities_task_created_idx ON activities(task_id, created_at);

CREATE TABLE task_threads (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL,
  codex_version TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  last_turn_id TEXT,
  last_event_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (
    status IN ('active', 'idle', 'completed', 'failed', 'archived')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (task_id, id)
) STRICT;

CREATE UNIQUE INDEX task_threads_primary_idx
  ON task_threads(task_id)
  WHERE is_primary = 1;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_thread_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'continue', 'cancel')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'running',
      'waiting_approval',
      'waiting_input',
      'canceling',
      'succeeded',
      'failed',
      'failed_recoverable',
      'canceled'
    )
  ),
  execution_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by TEXT REFERENCES actors(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_summary TEXT,
  queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (task_id, task_thread_id) REFERENCES task_threads(task_id, id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX jobs_active_execution_idx
  ON jobs(execution_key)
  WHERE kind IN ('start', 'continue')
    AND status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'canceling');
CREATE INDEX jobs_status_queued_idx ON jobs(status, queued_at);
CREATE INDEX jobs_task_id_idx ON jobs(task_id, queued_at);

CREATE TABLE job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  safe_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_payload_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (job_id, seq)
) STRICT;

CREATE INDEX job_events_job_seq_idx ON job_events(job_id, seq);

CREATE TABLE job_interactions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  server_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('command_approval', 'file_change_approval', 'user_input', 'other')
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'responded', 'expired', 'canceled')
  ),
  safe_request_json TEXT NOT NULL CHECK (json_valid(safe_request_json)),
  decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
  decided_by TEXT REFERENCES actors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  UNIQUE (job_id, server_request_id)
) STRICT;

CREATE INDEX job_interactions_job_status_idx ON job_interactions(job_id, status);

CREATE TABLE change_events (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_type TEXT NOT NULL CHECK (
    aggregate_type IN ('project', 'task', 'comment', 'attachment', 'job', 'interaction', 'system')
  ),
  aggregate_id TEXT,
  event_type TEXT NOT NULL,
  safe_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_payload_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX change_events_created_at_idx ON change_events(created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  request_id TEXT,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX audit_events_actor_created_idx ON audit_events(actor_id, created_at);
CREATE INDEX audit_events_resource_idx ON audit_events(resource_type, resource_id, created_at);

CREATE TRIGGER activities_no_update
BEFORE UPDATE ON activities
BEGIN
  SELECT RAISE(ABORT, 'activities are append-only');
END;

CREATE TRIGGER activities_no_delete
BEFORE DELETE ON activities
BEGIN
  SELECT RAISE(ABORT, 'activities are append-only');
END;

CREATE TRIGGER job_events_no_update
BEFORE UPDATE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;

CREATE TRIGGER job_events_no_delete
BEFORE DELETE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;

CREATE TRIGGER change_events_no_update
BEFORE UPDATE ON change_events
BEGIN
  SELECT RAISE(ABORT, 'change_events are append-only');
END;

CREATE TRIGGER change_events_no_delete
BEFORE DELETE ON change_events
BEGIN
  SELECT RAISE(ABORT, 'change_events are append-only');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
`;
