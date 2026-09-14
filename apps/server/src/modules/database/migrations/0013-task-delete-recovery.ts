export const TASK_DELETE_RECOVERY_SQL = `
ALTER TABLE task_delete_leases RENAME TO task_delete_leases_v12;

CREATE TABLE task_delete_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK (phase IN ('archiving', 'finalizing')),
  idempotency_key TEXT,
  request_hash TEXT,
  request_id TEXT,
  updated_at TEXT NOT NULL,
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json))
) STRICT;

INSERT INTO task_delete_leases (
  task_id, lease_token, actor_id, expected_version, snapshot_json, created_at,
  operation_id, phase, updated_at
)
SELECT
  task_id, lease_token, actor_id, expected_version, snapshot_json, created_at,
  lease_token, 'archiving', created_at
FROM task_delete_leases_v12;

DROP TABLE task_delete_leases_v12;

CREATE UNIQUE INDEX task_delete_leases_operation_id_idx
  ON task_delete_leases(operation_id);

CREATE TABLE task_delete_events (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('started', 'resumed', 'archive_completed', 'retry_failed', 'finalize_failed', 'completed')
  ),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX task_delete_events_task_id_idx
  ON task_delete_events(task_id, created_at);
CREATE INDEX task_delete_events_operation_id_idx
  ON task_delete_events(operation_id, created_at);

CREATE TRIGGER task_delete_events_no_update
BEFORE UPDATE ON task_delete_events
BEGIN
  SELECT RAISE(ABORT, 'task_delete_events are append-only');
END;

CREATE TRIGGER task_delete_events_no_delete
BEFORE DELETE ON task_delete_events
BEGIN
  SELECT RAISE(ABORT, 'task_delete_events are append-only');
END;
`;
