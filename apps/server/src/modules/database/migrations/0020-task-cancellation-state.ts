export const TASK_CANCELLATION_STATE_SQL = `
CREATE TABLE task_cancellation_states (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done')),
  blocked_from_status TEXT CHECK (blocked_from_status IN ('backlog', 'todo', 'in_progress', 'in_review')),
  sort_order REAL NOT NULL
) STRICT;

-- Recover the last recorded transition for tasks canceled before this migration.
INSERT INTO task_cancellation_states (task_id, status, blocked_from_status, sort_order)
SELECT tasks.id,
  COALESCE((SELECT json_extract(changes_json, '$.status.from') FROM activities
    WHERE task_id = tasks.id AND kind = 'task.moved'
      AND json_extract(changes_json, '$.status.to') = 'canceled'
      AND json_extract(changes_json, '$.status.from') IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done')
    ORDER BY created_at DESC, rowid DESC LIMIT 1), 'todo'),
  COALESCE((SELECT json_extract(changes_json, '$.status.from') FROM activities
    WHERE task_id = tasks.id AND kind = 'task.moved'
      AND json_extract(changes_json, '$.status.to') = 'blocked'
      AND json_extract(changes_json, '$.status.from') IN ('backlog', 'todo', 'in_progress', 'in_review')
    ORDER BY created_at DESC, rowid DESC LIMIT 1), 'todo'),
  tasks.sort_order
FROM tasks WHERE status = 'canceled';
UPDATE task_cancellation_states SET blocked_from_status = NULL WHERE status <> 'blocked';

CREATE TRIGGER tasks_capture_cancellation_state
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'canceled' AND OLD.status <> 'canceled'
BEGIN
  INSERT INTO task_cancellation_states (task_id, status, blocked_from_status, sort_order)
  VALUES (OLD.id, OLD.status, OLD.blocked_from_status, OLD.sort_order)
  ON CONFLICT(task_id) DO UPDATE SET status = excluded.status,
    blocked_from_status = excluded.blocked_from_status, sort_order = excluded.sort_order;
END;
`;
