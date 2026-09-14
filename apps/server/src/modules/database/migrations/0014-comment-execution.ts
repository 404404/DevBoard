export const COMMENT_EXECUTION_SQL = `
ALTER TABLE comments ADD COLUMN executed_at TEXT;
CREATE INDEX comments_pending_execution_idx ON comments(task_id, created_at)
  WHERE executed_at IS NULL AND deleted_at IS NULL;
`;
