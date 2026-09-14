export const TASK_LIFECYCLE_SQL = `
CREATE TABLE task_lifecycle_operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target_status TEXT NOT NULL CHECK (target_status IN ('done', 'canceled')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'failed', 'succeeded', 'abandoned')),
  phase TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  snapshot_json TEXT,
  error_summary TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_id, task_id, idempotency_key)
);
CREATE UNIQUE INDEX task_lifecycle_active_idx ON task_lifecycle_operations(task_id)
  WHERE status IN ('pending', 'running', 'failed');
CREATE TABLE task_lifecycle_resources (
  resource_key TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES task_lifecycle_operations(id) ON DELETE CASCADE
);
CREATE INDEX task_lifecycle_task_idx ON task_lifecycle_operations(task_id, created_at);
`;
