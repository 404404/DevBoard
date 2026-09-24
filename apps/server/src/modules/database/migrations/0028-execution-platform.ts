import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

export const LEGACY_UNCONFIGURED_CONNECTION_ID = "00000000-0000-4000-8000-0000000000a3";
export const LEGACY_UNCONFIGURED_PROFILE_ID = "00000000-0000-4000-8000-0000000000a4";

export const EXECUTION_PLATFORM_SQL = `
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type TEXT NOT NULL CHECK (type = 'ssh_host'),
  host TEXT,
  port INTEGER CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
  username TEXT,
  auth_mode TEXT NOT NULL DEFAULT 'identity_file' CHECK (auth_mode IN ('identity_file', 'agent')),
  identity TEXT,
  known_host_reference TEXT NOT NULL DEFAULT 'managed:known_hosts',
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    status IN ('unknown', 'checking', 'online', 'offline', 'authentication_required', 'error',
      'configuration_required', 'host_key_untrusted', 'host_key_changed')
  ),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  last_health_json TEXT CHECK (last_health_json IS NULL OR json_valid(last_health_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX connections_status_idx ON connections(enabled, status);

CREATE TABLE execution_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  provider_kind TEXT NOT NULL CHECK (length(trim(provider_kind)) > 0),
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  default_model TEXT,
  default_mode TEXT,
  default_reasoning_effort TEXT,
  environment_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(environment_refs_json) AND json_type(environment_refs_json) = 'array'
  ),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  health_json TEXT CHECK (health_json IS NULL OR json_valid(health_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (name),
  UNIQUE (provider_kind, connection_id, name)
) STRICT;

CREATE INDEX execution_profiles_connection_idx ON execution_profiles(connection_id, enabled);

ALTER TABLE projects ADD COLUMN default_execution_profile_id TEXT
  REFERENCES execution_profiles(id) ON DELETE SET NULL;

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'active', 'completed', 'canceled')
  ),
  target_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX milestones_project_status_idx ON milestones(project_id, status, target_date);

ALTER TABLE tasks ADD COLUMN milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;
CREATE INDEX tasks_milestone_idx ON tasks(milestone_id);

CREATE TABLE workspace_mappings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(trim(path)) > 0),
  is_default INTEGER NOT NULL DEFAULT 1 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, connection_id)
) STRICT;

CREATE UNIQUE INDEX workspace_mappings_default_idx
  ON workspace_mappings(project_id)
  WHERE is_default = 1;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_profile_id TEXT REFERENCES execution_profiles(id) ON DELETE SET NULL,
  provider_kind TEXT NOT NULL CHECK (length(trim(provider_kind)) > 0),
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  workspace TEXT,
  model TEXT,
  mode TEXT,
  permission_mode TEXT,
  reasoning_effort TEXT,
  provider_thread_id TEXT,
  provider_session_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'starting', 'running', 'waiting_approval', 'waiting_input',
      'succeeded', 'failed', 'canceled', 'interrupted', 'disconnected'
    )
  ),
  error_code TEXT,
  error_summary TEXT,
  legacy_job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX runs_task_created_idx ON runs(task_id, created_at);
CREATE INDEX runs_status_idx ON runs(status, updated_at);

ALTER TABLE jobs ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX jobs_run_id_idx ON jobs(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  summary TEXT NOT NULL DEFAULT '',
  safe_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_payload_json)),
  provider_event_json TEXT CHECK (
    provider_event_json IS NULL OR json_valid(provider_event_json)
  ),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
) STRICT;

CREATE INDEX run_events_run_seq_idx ON run_events(run_id, seq);

CREATE TABLE run_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider_kind TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  choices_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(choices_json) AND json_type(choices_json) = 'array'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'canceled', 'expired')
  ),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
) STRICT;

CREATE INDEX run_approvals_run_status_idx ON run_approvals(run_id, status);

CREATE TABLE change_events_v28 (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_type TEXT NOT NULL CHECK (
    aggregate_type IN (
      'project', 'task', 'comment', 'attachment', 'job', 'interaction',
      'milestone', 'connection', 'execution_profile', 'workspace_mapping',
      'run', 'system'
    )
  ),
  aggregate_id TEXT,
  event_type TEXT NOT NULL,
  safe_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_payload_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO change_events_v28 (
  revision, aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
) SELECT revision, aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
FROM change_events;

DROP TABLE change_events;
ALTER TABLE change_events_v28 RENAME TO change_events;
CREATE INDEX change_events_created_at_idx ON change_events(created_at);

CREATE TRIGGER change_events_no_update
BEFORE UPDATE ON change_events
BEGIN
  SELECT RAISE(ABORT, 'change_events are append-only');
END;

CREATE TRIGGER change_events_no_delete
BEFORE DELETE ON change_events
WHEN NOT EXISTS (
  SELECT 1 FROM task_delete_authorizations
  WHERE task_delete_authorizations.resource_id = OLD.aggregate_id
    OR json_extract(OLD.safe_payload_json, '$.taskId') = task_delete_authorizations.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'change_events are append-only');
END;
`;

function safeJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function migratedRunStatus(status: string): string {
  if (status === "waiting_approval" || status === "waiting_input") return status;
  if (status === "queued") return "queued";
  if (status === "running" || status === "canceling") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "canceled") return "canceled";
  return "failed";
}

function migratedEventType(kind: string, status: string): string {
  if (kind.includes("agent_message")) return "agent.message";
  if (kind.includes("command")) return "command.completed";
  if (kind.includes("file_change")) return "file.changed";
  if (kind.includes("approval")) return "approval.requested";
  if (kind.includes("failed") || status === "failed" || status === "failed_recoverable")
    return "run.failed";
  if (kind.includes("cancel") || status === "canceled") return "run.cancelled";
  if (kind.includes("complete") || kind.includes("succeed") || status === "succeeded")
    return "run.completed";
  if (kind.includes("started") || kind.includes("queued")) return "run.started";
  return "run.progress";
}

export function migrateExecutionPlatform(database: Database.Database): void {
  const timestamp = new Date().toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO connections (
        id, name, type, host, port, username, auth_mode, identity, known_host_reference,
        status, capabilities_json, last_health_json, enabled, version, created_at, updated_at
      ) VALUES (?, 'Legacy Local Codex (configuration required)', 'ssh_host', NULL, NULL, NULL,
        'identity_file', NULL, 'managed:known_hosts', 'configuration_required', ?, NULL, 0, 1, ?, ?)`,
    )
    .run(
      LEGACY_UNCONFIGURED_CONNECTION_ID,
      JSON.stringify({ providerExecutables: [], protocolModes: [] }),
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `INSERT OR IGNORE INTO execution_profiles (
        id, name, provider_kind, connection_id, capabilities_json, enabled, created_at, updated_at
      ) VALUES (?, 'Legacy Local Codex (configuration required)', 'codex', ?, ?, 0, ?, ?)`,
    )
    .run(
      LEGACY_UNCONFIGURED_PROFILE_ID,
      LEGACY_UNCONFIGURED_CONNECTION_ID,
      JSON.stringify({
        streaming: false,
        approvals: false,
        userInput: false,
        cancel: false,
        resume: false,
        models: false,
        reasoningEffort: false,
        modes: false,
        permissionModes: false,
        workspace: false,
      }),
      timestamp,
      timestamp,
    );
  const jobs = database
    .prepare(
      `SELECT
        jobs.id, jobs.task_id AS taskId, jobs.task_thread_id AS taskThreadId, jobs.kind,
        jobs.status, jobs.work_context_json AS workContextJson, jobs.error_code AS errorCode,
        jobs.error_summary AS errorSummary, jobs.queued_at AS queuedAt,
        jobs.started_at AS startedAt, jobs.completed_at AS finishedAt, jobs.updated_at AS updatedAt,
        task_threads.thread_id AS providerSessionId,
        task_threads.cwd AS threadCwd
       FROM jobs
       LEFT JOIN task_threads ON task_threads.id = jobs.task_thread_id
       WHERE jobs.kind <> 'cancel'`,
    )
    .all() as Array<Record<string, unknown>>;
  const insertRun = database.prepare(
    `INSERT OR IGNORE INTO runs (
      id, task_id, execution_profile_id, provider_kind, connection_id, workspace, model,
      mode, permission_mode, reasoning_effort, provider_thread_id, provider_session_id, status, error_code, error_summary, legacy_job_id,
      created_at, started_at, finished_at, updated_at
    ) VALUES (?, ?, ?, 'codex', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateJob = database.prepare("UPDATE jobs SET run_id = ? WHERE id = ?");
  const insertEvent = database.prepare(
    `INSERT OR IGNORE INTO run_events (
      id, run_id, seq, event_type, summary, safe_payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertApproval = database.prepare(
    `INSERT OR IGNORE INTO run_approvals (
      id, run_id, provider_kind, approval_type, summary, details_json,
      choices_json, status, requested_at, resolved_at, resolved_by
    ) VALUES (?, ?, 'codex', ?, ?, ?, '[]', ?, ?, ?, NULL)`,
  );

  for (const job of jobs) {
    const workContext = safeJson(job.workContextJson, {}) as Record<string, unknown>;
    const modelOptions =
      workContext.modelOptions && typeof workContext.modelOptions === "object"
        ? (workContext.modelOptions as Record<string, unknown>)
        : {};
    const runId = randomUUID();
    const status = migratedRunStatus(String(job.status));
    const workspace =
      typeof workContext.cwd === "string"
        ? workContext.cwd
        : typeof job.threadCwd === "string"
          ? job.threadCwd
          : null;
    insertRun.run(
      runId,
      String(job.taskId),
      LEGACY_UNCONFIGURED_PROFILE_ID,
      LEGACY_UNCONFIGURED_CONNECTION_ID,
      workspace,
      typeof modelOptions.model === "string" ? modelOptions.model : null,
      nullableString(modelOptions.effort),
      nullableString(job.providerSessionId),
      nullableString(job.providerSessionId),
      status,
      nullableString(job.errorCode),
      nullableString(job.errorSummary),
      String(job.id),
      String(job.queuedAt),
      nullableString(job.startedAt),
      nullableString(job.finishedAt),
      String(job.updatedAt),
    );
    updateJob.run(runId, String(job.id));

    const events = database
      .prepare(
        `SELECT id, seq, kind, summary, safe_payload_json AS payload, created_at AS createdAt
         FROM job_events WHERE job_id = ? ORDER BY seq`,
      )
      .all(String(job.id)) as Array<Record<string, unknown>>;
    for (const event of events) {
      insertEvent.run(
        randomUUID(),
        runId,
        Number(event.seq),
        migratedEventType(String(event.kind), String(job.status)),
        String(event.summary),
        JSON.stringify(safeJson(event.payload, {})),
        String(event.createdAt),
      );
    }

    const approvals = database
      .prepare(
        `SELECT id, kind, safe_request_json AS details, status, created_at AS requestedAt,
                decided_at AS resolvedAt
         FROM job_interactions WHERE job_id = ? ORDER BY created_at`,
      )
      .all(String(job.id)) as Array<Record<string, unknown>>;
    for (const approval of approvals) {
      const decision = safeJson(
        database
          .prepare("SELECT decision_json FROM job_interactions WHERE id = ?")
          .pluck()
          .get(String(approval.id)),
        null,
      ) as Record<string, unknown> | null;
      const decisionType = typeof decision?.type === "string" ? decision.type : null;
      const approvalStatus =
        String(approval.status) === "pending"
          ? "pending"
          : decisionType === "accept"
            ? "approved"
            : decisionType === "cancel"
              ? "canceled"
              : "rejected";
      insertApproval.run(
        randomUUID(),
        runId,
        String(approval.kind),
        String(approval.kind),
        JSON.stringify(safeJson(approval.details, {})),
        approvalStatus,
        String(approval.requestedAt),
        nullableString(approval.resolvedAt),
      );
    }
  }
}
