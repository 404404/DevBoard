export const DESKTOP_OUTCOME_CORRECTION_SQL = `
DROP TRIGGER jobs_legal_status_transition;
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
  (OLD.status = 'canceling' AND NEW.status IN ('canceled', 'failed', 'failed_recoverable')) OR
  (OLD.status = 'canceling' AND NEW.status = 'running' AND OLD.kind != 'cancel'
    AND OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NULL
    AND OLD.error_code IN ('CODEX_OUTCOME_UNKNOWN', 'CONNECTOR_DISCONNECTED', 'RESTART_UNCERTAIN')
    AND json_extract(NEW.recovery_checkpoint_json, '$.recoveredTurnId') IS NOT NULL
    AND json_extract(NEW.recovery_checkpoint_json, '$.recoveredTurnId') = json_extract(NEW.recovery_checkpoint_json, '$.turnId')
    AND (json_extract(OLD.recovery_checkpoint_json, '$.turnId') IS NULL OR
      json_extract(OLD.recovery_checkpoint_json, '$.turnId') = json_extract(NEW.recovery_checkpoint_json, '$.turnId'))) OR
  COALESCE((OLD.status = 'failed' AND NEW.status IN ('running', 'succeeded') AND OLD.kind != 'cancel'
    AND OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NULL
    AND OLD.error_code IN ('TURN_INTERRUPTED', 'TURN_FAILED')
    AND json_extract(OLD.recovery_checkpoint_json, '$.recoveredTurnId') IS NOT NULL
    AND json_extract(OLD.recovery_checkpoint_json, '$.recoveredTurnId') = json_extract(OLD.recovery_checkpoint_json, '$.turnId')
    AND json_extract(NEW.recovery_checkpoint_json, '$.correctedTurnId') = json_extract(OLD.recovery_checkpoint_json, '$.turnId')
    AND json_extract(NEW.recovery_checkpoint_json, '$.turnId') = json_extract(OLD.recovery_checkpoint_json, '$.turnId')), 0)

)
BEGIN
  SELECT RAISE(ABORT, 'illegal job status transition');
END;
`;
