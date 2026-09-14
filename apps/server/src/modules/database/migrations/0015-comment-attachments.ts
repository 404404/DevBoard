// Rebuild with foreign keys disabled by the migrator, retaining all comment IDs
// and attachment references. Nonempty body-or-attachments is enforced by the
// service transaction because a CHECK cannot inspect another table.
export const COMMENT_ATTACHMENTS_SQL = `
CREATE TABLE comments_with_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  executed_at TEXT,
  UNIQUE (task_id, id)
) STRICT;
INSERT INTO comments_with_attachments
  SELECT id, task_id, author_id, body, version, created_at, updated_at, deleted_at, executed_at FROM comments;
DROP TABLE comments;
ALTER TABLE comments_with_attachments RENAME TO comments;
CREATE INDEX comments_task_created_idx ON comments(task_id, created_at);
CREATE INDEX comments_pending_execution_idx ON comments(task_id, created_at)
  WHERE executed_at IS NULL AND deleted_at IS NULL;
ALTER TABLE attachments ADD COLUMN pending_comment INTEGER NOT NULL DEFAULT 0
  CHECK (pending_comment IN (0, 1) AND (pending_comment = 0 OR comment_id IS NULL));
`;
