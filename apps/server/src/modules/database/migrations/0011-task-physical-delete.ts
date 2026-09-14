export const TASK_PHYSICAL_DELETE_SQL = `
CREATE TABLE task_delete_authorizations (
  task_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, resource_id)
) STRICT;

DROP TRIGGER activities_no_delete;
CREATE TRIGGER activities_no_delete
BEFORE DELETE ON activities
WHEN NOT EXISTS (
  SELECT 1 FROM task_delete_authorizations
  WHERE task_delete_authorizations.task_id = OLD.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'activities are append-only');
END;

DROP TRIGGER job_events_no_delete;
CREATE TRIGGER job_events_no_delete
BEFORE DELETE ON job_events
WHEN NOT EXISTS (
  SELECT 1 FROM task_delete_authorizations
  WHERE task_delete_authorizations.resource_id = OLD.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;

DROP TRIGGER change_events_no_delete;
CREATE TRIGGER change_events_no_delete
BEFORE DELETE ON change_events
WHEN NOT EXISTS (
  SELECT 1
  FROM task_delete_authorizations
  WHERE task_delete_authorizations.resource_id = OLD.aggregate_id
    OR json_extract(OLD.safe_payload_json, '$.taskId') = task_delete_authorizations.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'change_events are append-only');
END;

DROP TRIGGER audit_events_no_delete;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN NOT EXISTS (
  SELECT 1
  FROM task_delete_authorizations
  WHERE task_delete_authorizations.resource_id = OLD.resource_id
    OR json_extract(OLD.safe_metadata_json, '$.taskId') = task_delete_authorizations.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
`;
