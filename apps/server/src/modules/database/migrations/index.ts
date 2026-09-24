import { EXECUTION_PLATFORM_SQL, migrateExecutionPlatform } from "./0028-execution-platform.js";
import { SSH_IDENTITY_REFERENCES_MIGRATION } from "./0029-ssh-identity-references.js";
import { DESKTOP_OUTCOME_CORRECTION_SQL } from "./0026-desktop-outcome-correction.js";
import { WEB_CLI_AUTH_VERSION_SQL } from "./0027-web-cli-auth-version.js";
import { EXECUTION_RESULT_RECOVERY_SQL } from "./0025-execution-result-recovery.js";
import { TASK_MODEL_OPTIONS_SQL } from "./0024-task-model-options.js";
import { webAccountsMigration } from "./0023-web-accounts.js";
import { CORE_SCHEMA_SQL } from "./0001-core-schema.js";
import { PROJECT_CONTEXTS_SQL } from "./0002-project-contexts.js";
import { REQUEST_IDEMPOTENCY_SQL } from "./0003-request-idempotency.js";
import { EXECUTION_QUEUE_SQL } from "./0004-execution-queue.js";
import { CORE_FEATURES_SQL } from "./0005-core-features.js";
import { CODEX_PROJECT_SYNC_SQL } from "./0006-codex-project-sync.js";
import {
  migrateProjectKeyFormat,
  PROJECT_KEY_FORMAT_SQL,
  PROJECT_KEY_FORMAT_TRANSFORM_CHECKSUM,
} from "./0007-project-key-format.js";
import { TASK_CREATE_OPTIONS_SQL } from "./0008-task-create-options.js";
import { GLOBAL_LABELS_SQL } from "./0009-global-labels.js";
import { TASK_BLOCKED_ORIGIN_SQL } from "./0010-task-blocked-origin.js";
import { TASK_PHYSICAL_DELETE_SQL } from "./0011-task-physical-delete.js";
import { TASK_DELETE_LEASE_SQL } from "./0012-task-delete-lease.js";
import { TASK_DELETE_RECOVERY_SQL } from "./0013-task-delete-recovery.js";

import { COMMENT_EXECUTION_SQL } from "./0014-comment-execution.js";

import { COMMENT_ATTACHMENTS_SQL } from "./0015-comment-attachments.js";
import { TASK_LIFECYCLE_SQL } from "./0016-task-lifecycle.js";
import { JOB_ATTACHMENT_SNAPSHOTS_SQL } from "./0017-job-attachment-snapshots.js";

import type { Migration } from "../migrator.js";
import { JOB_WORKSPACE_EVIDENCE_SQL } from "./0018-job-workspace-evidence.js";

import { LEGACY_EXECUTION_REPAIR_SQL } from "./0019-legacy-execution-repair.js";
import { TASK_CANCELLATION_STATE_SQL } from "./0020-task-cancellation-state.js";
import {
  feishuUserIdentitiesMigration,
  type LegacyIdentityMapping,
} from "./0021-feishu-user-identities.js";
import { MULTIPLE_CHILD_TASKS_SQL } from "./0022-multiple-child-tasks.js";
export type { LegacyIdentityMapping } from "./0021-feishu-user-identities.js";

const LEGACY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core_schema",
    sql: CORE_SCHEMA_SQL,
  },
  {
    version: 2,
    name: "project_contexts",
    sql: PROJECT_CONTEXTS_SQL,
  },
  {
    version: 3,
    name: "request_idempotency",
    sql: REQUEST_IDEMPOTENCY_SQL,
  },
  {
    version: 4,
    name: "execution_queue",
    sql: EXECUTION_QUEUE_SQL,
  },
  {
    version: 5,
    name: "core_features",
    sql: CORE_FEATURES_SQL,
  },
  {
    version: 6,
    name: "codex_project_sync",
    sql: CODEX_PROJECT_SYNC_SQL,
  },
  {
    version: 7,
    name: "project_key_format",
    sql: PROJECT_KEY_FORMAT_SQL,
    transformChecksum: PROJECT_KEY_FORMAT_TRANSFORM_CHECKSUM,
    transform: migrateProjectKeyFormat,
    foreignKeysDisabled: true,
  },
  {
    version: 8,
    name: "task_create_options",
    sql: TASK_CREATE_OPTIONS_SQL,
  },
  {
    version: 9,
    name: "global_labels",
    sql: GLOBAL_LABELS_SQL,
  },
  {
    version: 10,
    name: "task_blocked_origin",
    sql: TASK_BLOCKED_ORIGIN_SQL,
  },
  {
    version: 11,
    name: "task_physical_delete",
    sql: TASK_PHYSICAL_DELETE_SQL,
  },
  {
    version: 12,
    name: "task_delete_lease",
    sql: TASK_DELETE_LEASE_SQL,
  },
  {
    version: 13,
    name: "task_delete_recovery",
    sql: TASK_DELETE_RECOVERY_SQL,
  },
  { version: 14, name: "comment_execution", sql: COMMENT_EXECUTION_SQL },
  {
    version: 15,
    name: "comment_attachments",
    sql: COMMENT_ATTACHMENTS_SQL,
    foreignKeysDisabled: true,
  },
  { version: 16, name: "task_lifecycle", sql: TASK_LIFECYCLE_SQL },
  { version: 17, name: "job_attachment_snapshots", sql: JOB_ATTACHMENT_SNAPSHOTS_SQL },
  { version: 18, name: "job_workspace_evidence", sql: JOB_WORKSPACE_EVIDENCE_SQL },
  { version: 19, name: "legacy_execution_repair", sql: LEGACY_EXECUTION_REPAIR_SQL },
  { version: 20, name: "task_cancellation_state", sql: TASK_CANCELLATION_STATE_SQL },
];

export function identityMigrations(
  mappings: readonly LegacyIdentityMapping[],
): readonly Migration[] {
  return [
    ...LEGACY_MIGRATIONS,
    feishuUserIdentitiesMigration(mappings),
    { version: 22, name: "multiple_child_tasks", sql: MULTIPLE_CHILD_TASKS_SQL },
    webAccountsMigration,
    { version: 24, name: "task_model_options", sql: TASK_MODEL_OPTIONS_SQL },
    { version: 25, name: "execution_result_recovery", sql: EXECUTION_RESULT_RECOVERY_SQL },
    { version: 26, name: "desktop_outcome_correction", sql: DESKTOP_OUTCOME_CORRECTION_SQL },
    { version: 27, name: "web_cli_auth_version", sql: WEB_CLI_AUTH_VERSION_SQL },
    {
      version: 28,
      name: "execution_platform",
      sql: EXECUTION_PLATFORM_SQL,
      transformChecksum: "execution-platform-v1",
      transform: migrateExecutionPlatform,
    },
    SSH_IDENTITY_REFERENCES_MIGRATION,
  ];
}

export const CORE_MIGRATIONS: readonly Migration[] = identityMigrations([]);
