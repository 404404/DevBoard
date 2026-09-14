export const TASK_BLOCKED_ORIGIN_SQL = `
ALTER TABLE tasks ADD COLUMN blocked_from_status TEXT;

UPDATE tasks
SET blocked_from_status = COALESCE(
  (
    SELECT json_extract(activities.changes_json, '$.status.from')
    FROM activities
    WHERE activities.task_id = tasks.id
      AND activities.kind = 'task.moved'
      AND json_extract(activities.changes_json, '$.status.to') = 'blocked'
      AND json_extract(activities.changes_json, '$.status.from')
        IN ('backlog', 'todo', 'in_progress', 'in_review')
    ORDER BY activities.created_at DESC, activities.id DESC
    LIMIT 1
  ),
  'in_progress'
)
WHERE status = 'blocked';

CREATE TRIGGER tasks_blocked_origin_insert
BEFORE INSERT ON tasks
WHEN (
  NEW.status = 'blocked'
  AND (
    NEW.blocked_from_status IS NULL
    OR NEW.blocked_from_status NOT IN ('backlog', 'todo', 'in_progress', 'in_review')
  )
) OR (NEW.status <> 'blocked' AND NEW.blocked_from_status IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid task blocked origin');
END;

CREATE TRIGGER tasks_blocked_origin_update
BEFORE UPDATE OF status, blocked_from_status ON tasks
WHEN (
  NEW.status = 'blocked'
  AND (
    NEW.blocked_from_status IS NULL
    OR NEW.blocked_from_status NOT IN ('backlog', 'todo', 'in_progress', 'in_review')
  )
) OR (NEW.status <> 'blocked' AND NEW.blocked_from_status IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid task blocked origin');
END;

CREATE INDEX tasks_project_blocked_origin_order_idx
  ON tasks(project_id, blocked_from_status, sort_order)
  WHERE status = 'blocked' AND archived_at IS NULL;
`;
