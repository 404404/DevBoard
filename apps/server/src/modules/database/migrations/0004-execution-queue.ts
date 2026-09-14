export const EXECUTION_QUEUE_SQL = `
ALTER TABLE jobs ADD COLUMN request_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
  CHECK (length(request_hash) = 64);
ALTER TABLE jobs ADD COLUMN work_context_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(work_context_json));
ALTER TABLE jobs ADD COLUMN recovery_checkpoint_json TEXT
  CHECK (recovery_checkpoint_json IS NULL OR json_valid(recovery_checkpoint_json));
ALTER TABLE jobs ADD COLUMN target_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN cancel_requested_at TEXT;

CREATE UNIQUE INDEX jobs_active_cancel_target_idx
  ON jobs(target_job_id)
  WHERE kind = 'cancel'
    AND status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'canceling');

CREATE TRIGGER jobs_cancel_target_required_insert
BEFORE INSERT ON jobs
WHEN (NEW.kind = 'cancel') != (NEW.target_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'cancel jobs require target_job_id');
END;

CREATE TRIGGER jobs_cancel_target_required_update
BEFORE UPDATE OF kind, target_job_id ON jobs
WHEN (NEW.kind = 'cancel') != (NEW.target_job_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'cancel jobs require target_job_id');
END;

CREATE TRIGGER jobs_legal_status_transition
BEFORE UPDATE OF status ON jobs
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('running', 'canceled', 'failed', 'failed_recoverable')) OR
  (OLD.status = 'running' AND NEW.status IN (
    'queued', 'waiting_approval', 'waiting_input', 'canceling',
    'succeeded', 'failed', 'failed_recoverable', 'canceled'
  )) OR
  (OLD.status = 'waiting_approval' AND NEW.status IN (
    'queued', 'running', 'canceling', 'failed', 'failed_recoverable', 'canceled'
  )) OR
  (OLD.status = 'waiting_input' AND NEW.status IN (
    'queued', 'running', 'canceling', 'failed', 'failed_recoverable', 'canceled'
  )) OR
  (OLD.status = 'canceling' AND NEW.status IN ('canceled', 'failed', 'failed_recoverable'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal job status transition');
END;
`;
