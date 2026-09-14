export const TASK_DELETE_LEASE_SQL = `
CREATE TABLE task_delete_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL
) STRICT;
`;
