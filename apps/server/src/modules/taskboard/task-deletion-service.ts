import { identityKey, identityFromKey, IdentityKeySchema } from "@codexboard/contracts";
import { createHash, randomUUID } from "node:crypto";

import {
  PrincipalViewSchema,
  DeleteTaskResultSchema,
  type DeleteTaskCommand,
  type DeleteTaskResult,
  type RestoreTaskCommand,
  type TaskMutationResult,
} from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { CodexRequestError } from "../codex/index.js";
import type { AttachmentVault, QuarantinedAttachments } from "../attachments/index.js";
import type { SqliteDatabase } from "../database/index.js";
import type { CodexThreadProvisioner } from "../execution/index.js";
import type { MutationContext, Taskboard } from "./taskboard.js";
import { assertTaskLifecycleAvailable } from "./task-lifecycle-guard.js";

const ACTIVE_JOB_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "canceling",
] as const;

const IdempotencyRowSchema = z.object({ requestHash: z.string(), responseJson: z.string() });
const TaskDeleteRowSchema = z.object({
  projectId: z.uuid(),
  status: z.string(),
  version: z.number().int().positive(),
  archivedAt: z.string().datetime().nullable(),
});
const TaskDeleteLeaseRowSchema = z.object({
  operationId: z.uuid(),
  leaseToken: z.uuid(),
  principalKey: IdentityKeySchema,
  expectedVersion: z.number().int().positive(),
  snapshotJson: z.string(),
  phase: z.enum(["archiving", "finalizing"]),
  idempotencyKey: z.string().nullable(),
  requestHash: z.string().nullable(),
  requestId: z.string().nullable(),
});
const StringRowSchema = z.object({ value: z.string() });

interface TaskDeletionSnapshot {
  readonly attachmentStorageKeys: readonly string[];
  readonly threadIds: readonly string[];
  readonly resourceIds: readonly string[];
}

interface TaskDeleteOperation {
  readonly operationId: string;
  readonly token: string;
  readonly principalKey: string;
  readonly expectedVersion: number;
  readonly snapshot: TaskDeletionSnapshot;
  readonly phase: "archiving" | "finalizing";
  readonly idempotencyKey: string | null;
  readonly requestHash: string | null;
  readonly requestId: string | null;
}

interface TaskDeletionServiceOptions {
  readonly database: SqliteDatabase;
  readonly taskboard: Taskboard;
  readonly vault: AttachmentVault;
  readonly provisioner: CodexThreadProvisioner | null;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
}

export class TaskDeletionService {
  readonly #database: SqliteDatabase;
  readonly #taskboard: Taskboard;
  readonly #vault: AttachmentVault;
  readonly #provisioner: CodexThreadProvisioner | null;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;
  readonly #inFlight = new Map<string, Promise<DeleteTaskResult>>();
  readonly #activeTasks = new Set<string>();

  constructor(options: TaskDeletionServiceOptions) {
    this.#database = options.database;
    this.#taskboard = options.taskboard;
    this.#vault = options.vault;
    this.#provisioner = options.provisioner;
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
  }

  restoreTask(
    taskId: string,
    command: RestoreTaskCommand,
    context: MutationContext,
  ): TaskMutationResult {
    return this.#taskboard.restoreTask(taskId, command, context, () => {
      const lease = this.#database
        .prepare("SELECT last_error_json AS error FROM task_delete_leases WHERE task_id = ?")
        .get(taskId) as { error: string | null } | undefined;
      if (!lease) return;
      if (this.#activeTasks.has(taskId) || !lease.error) {
        throw new AppError("VERSION_CONFLICT", 409, "任务正在删除，请稍后重试");
      }
      assertTaskLifecycleAvailable(this.#database, taskId);
      const operation = this.#readOperation(taskId);
      // Quarantine can be reopened after a restart. Restore bytes before releasing
      // the write fence; if anything fails the durable operation remains retryable.
      const batch = this.#vault.quarantine(
        operation.snapshot.attachmentStorageKeys,
        operation.operationId,
      );
      this.#vault.restore(batch);
      this.#database
        .prepare("DELETE FROM task_delete_leases WHERE task_id = ? AND lease_token = ?")
        .run(taskId, operation.token);
      this.#database
        .prepare(
          `INSERT INTO audit_events (
        id, identity_key, action, resource_type, resource_id, outcome, request_id, safe_metadata_json, created_at
      ) VALUES (?, ?, 'task.delete_aborted', 'task', ?, 'allowed', ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          identityKey(context.actor.identity),
          taskId,
          context.requestId ?? null,
          JSON.stringify({ operationId: operation.operationId, phase: operation.phase }),
          this.#now().toISOString(),
        );
    });
  }

  delete(
    taskId: string,
    command: DeleteTaskCommand,
    context: MutationContext,
  ): Promise<DeleteTaskResult> {
    const key = `${identityKey(context.actor.identity)}:${taskId}:${context.idempotencyKey}`;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    if (this.#activeTasks.has(taskId)) {
      return Promise.reject(new AppError("VERSION_CONFLICT", 409, "任务正在删除，请稍后重试"));
    }
    this.#activeTasks.add(taskId);
    const deleting = this.#delete(taskId, command, context).finally(() => {
      this.#inFlight.delete(key);
      this.#activeTasks.delete(taskId);
    });
    this.#inFlight.set(key, deleting);
    return deleting;
  }

  async resumePending(): Promise<void> {
    const taskIds = this.#values(
      "SELECT task_id AS value FROM task_delete_leases ORDER BY created_at, task_id",
    );
    await Promise.allSettled(
      taskIds.map(async (taskId) => {
        if (this.#activeTasks.has(taskId)) return;
        const operation = this.#readOperation(taskId);
        const actorRow = this.#database
          .prepare(
            `SELECT name, avatar_url AS avatarUrl, role FROM identities WHERE identity_key = ?`,
          )
          .get(operation.principalKey) as Record<string, unknown> | undefined;
        if (!actorRow) throw new AppError("FORBIDDEN", 403, "删除操作的发起人不存在");
        const actor = PrincipalViewSchema.parse({
          ...actorRow,
          identity: identityFromKey(operation.principalKey),
        });
        await this.delete(
          taskId,
          { expectedVersion: operation.expectedVersion },
          {
            actor,
            idempotencyKey: operation.idempotencyKey ?? `delete-recovery:${operation.operationId}`,
            ...(operation.requestId ? { requestId: operation.requestId } : {}),
          },
        );
      }),
    );
  }

  async #delete(
    taskId: string,
    command: DeleteTaskCommand,
    context: MutationContext,
  ): Promise<DeleteTaskResult> {
    const scope = `task.delete:${taskId}`;
    const requestHash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const replay = this.#readReplay(scope, context, requestHash);
    if (replay) return replay;

    let operation = this.#acquireLease(taskId, command, context, requestHash);
    const { snapshot } = operation;

    let quarantine: QuarantinedAttachments | undefined;
    let archivingThreadId: string | undefined;
    try {
      quarantine = this.#vault.quarantine(snapshot.attachmentStorageKeys, operation.operationId);
      if (operation.phase === "archiving") {
        if (snapshot.threadIds.length > 0 && !this.#provisioner) {
          throw new AppError(
            "UPSTREAM_ERROR",
            503,
            "Codex App Server 当前不可用，无法归档原始任务",
          );
        }
        if (this.#provisioner) {
          for (const threadId of snapshot.threadIds) {
            archivingThreadId = threadId;
            await this.#provisioner.archiveThread(threadId);
          }
        }
        operation = this.#markArchiveCompleted(taskId, operation);
      }
    } catch (cause: unknown) {
      const repeated = this.#readReplay(scope, context, requestHash);
      if (repeated) {
        if (quarantine) this.#discardQuarantine(quarantine);
        return repeated;
      }
      this.#recordFailure(taskId, operation, "retry_failed", cause);
      if (cause instanceof AppError) throw cause;
      if (
        archivingThreadId &&
        cause instanceof CodexRequestError &&
        cause.code === -32600 &&
        /^thread .+ already has an active writer$/.test(cause.message)
      ) {
        throw new AppError(
          "INVALID_REQUEST",
          409,
          "原始对话仍被 Codex Desktop 占用。请先在 Codex Desktop 中归档该对话，再点击永久删除重试。",
          {
            cause,
            details: { reason: "CODEX_DESKTOP_THREAD_BUSY", threadId: archivingThreadId },
          },
        );
      }
      throw new AppError("UPSTREAM_ERROR", 502, "关联的 Codex 原始任务归档失败", {
        cause,
      });
    }

    let result: DeleteTaskResult;
    try {
      result = this.#database
        .transaction(() => {
          const repeated = this.#readReplay(scope, context, requestHash);
          if (repeated) return repeated;

          const persistedLease = this.#readOperation(taskId);
          if (
            persistedLease.operationId !== operation.operationId ||
            persistedLease.token !== operation.token ||
            persistedLease.phase !== "finalizing" ||
            persistedLease.expectedVersion !== operation.expectedVersion ||
            !sameSnapshot(persistedLease.snapshot, operation.snapshot)
          ) {
            throw new AppError("VERSION_CONFLICT", 409, "任务删除执行权已变化，请重新操作");
          }
          const row = this.#readTaskRow(taskId);
          this.#assertDeletable(row.status, row.archivedAt, row.version, operation.expectedVersion);
          this.#assertNoActiveJobs(taskId);
          const currentSnapshot = this.#snapshot(taskId);
          if (!sameSnapshot(currentSnapshot, snapshot)) {
            throw new AppError("VERSION_CONFLICT", 409, "任务关联数据已变化，请重新加载后再删除");
          }

          const timestamp = this.#now().toISOString();
          const authorize = this.#database.prepare(
            `INSERT INTO task_delete_authorizations (
            task_id, resource_id, identity_key, created_at
          ) VALUES (?, ?, ?, ?)`,
          );
          for (const resourceId of currentSnapshot.resourceIds) {
            authorize.run(taskId, resourceId, operation.principalKey, timestamp);
          }

          this.#database
            .prepare(
              `DELETE FROM change_events
            WHERE EXISTS (
              SELECT 1 FROM task_delete_authorizations
              WHERE task_delete_authorizations.task_id = ?
                AND (
                  task_delete_authorizations.resource_id = change_events.aggregate_id
                  OR json_extract(change_events.safe_payload_json, '$.taskId') = ?
                )
            )`,
            )
            .run(taskId, taskId);
          this.#database
            .prepare(
              `DELETE FROM audit_events
            WHERE EXISTS (
              SELECT 1 FROM task_delete_authorizations
              WHERE task_delete_authorizations.task_id = ?
                AND (
                  task_delete_authorizations.resource_id = audit_events.resource_id
                  OR json_extract(audit_events.safe_metadata_json, '$.taskId') = ?
                )
            )`,
            )
            .run(taskId, taskId);
          this.#deleteRelatedIdempotency(currentSnapshot.resourceIds, taskId);

          const change = this.#database
            .prepare(
              `INSERT INTO change_events (
              aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
            ) VALUES ('task', ?, 'task.deleted', ?, ?)`,
            )
            .run(taskId, JSON.stringify({ projectId: row.projectId, taskId }), timestamp);
          const deletionResult = DeleteTaskResultSchema.parse({
            taskId,
            projectId: row.projectId,
            revision: Number(change.lastInsertRowid),
          });
          this.#database
            .prepare(
              `INSERT INTO audit_events (
              id, identity_key, action, resource_type, resource_id, outcome,
              request_id, safe_metadata_json, created_at
            ) VALUES (?, ?, 'task.delete', 'task', ?, 'allowed', ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              operation.principalKey,
              taskId,
              operation.requestId,
              JSON.stringify({ projectId: row.projectId, operationId: operation.operationId }),
              timestamp,
            );
          this.#storeReplays(taskId, operation, context, deletionResult, timestamp);
          this.#appendDeleteEvent(
            operation.operationId,
            taskId,
            operation.principalKey,
            "completed",
            {
              projectId: row.projectId,
              revision: deletionResult.revision,
            },
          );
          // Remove cancel references before targets, and jobs before task_threads.
          // Their SET NULL foreign keys otherwise violate required columns/triggers.
          this.#database
            .prepare("DELETE FROM jobs WHERE task_id = ? AND kind = 'cancel'")
            .run(taskId);
          this.#database.prepare("DELETE FROM jobs WHERE task_id = ?").run(taskId);
          const deleted = this.#database.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
          if (deleted.changes !== 1) {
            throw new AppError("VERSION_CONFLICT", 409, "任务已被其他成员删除");
          }
          this.#database
            .prepare("DELETE FROM task_delete_authorizations WHERE task_id = ?")
            .run(taskId);
          return deletionResult;
        })
        .immediate();
    } catch (cause: unknown) {
      const repeated = this.#readReplay(scope, context, requestHash);
      if (repeated) {
        if (quarantine) this.#discardQuarantine(quarantine);
        return repeated;
      }
      this.#recordFailure(taskId, operation, "finalize_failed", cause);
      if (cause instanceof AppError) throw cause;
      throw new AppError("UPSTREAM_ERROR", 502, "任务删除失败", { cause });
    }

    if (quarantine) this.#discardQuarantine(quarantine);
    this.#onRevisionCommitted?.(result.revision);
    return result;
  }

  #assertDeletable(
    status: string,
    archivedAt: string | null,
    version: number,
    expectedVersion: number,
  ): void {
    if (version !== expectedVersion) {
      throw new AppError("VERSION_CONFLICT", 409, "任务版本已变化，请重新加载后再删除");
    }
    if (status !== "canceled" && status !== "done") {
      throw new AppError("INVALID_REQUEST", 409, "只有已完成或已取消的任务可以彻底删除");
    }
    if (archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "已归档任务不能彻底删除");
    }
  }

  #assertNoActiveJobs(taskId: string): void {
    const placeholders = ACTIVE_JOB_STATUSES.map(() => "?").join(", ");
    const active = this.#database
      .prepare(`SELECT 1 FROM jobs WHERE task_id = ? AND status IN (${placeholders}) LIMIT 1`)
      .get(taskId, ...ACTIVE_JOB_STATUSES);
    if (active) throw new AppError("INVALID_REQUEST", 409, "任务仍有执行中的作业，无法彻底删除");
  }

  #acquireLease(
    taskId: string,
    command: DeleteTaskCommand,
    context: MutationContext,
    requestHash: string,
  ): TaskDeleteOperation {
    return this.#database
      .transaction(() => {
        assertTaskLifecycleAvailable(this.#database, taskId);
        const existing = this.#readOperation(taskId, false);
        if (existing) {
          if (existing.principalKey !== identityKey(context.actor.identity)) {
            const visible = this.#taskboard.readTask(taskId, context.actor);
            if (!visible.permissions.canWrite) {
              throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
            }
          }
          if (existing.expectedVersion !== command.expectedVersion) {
            throw new AppError("VERSION_CONFLICT", 409, "任务版本已变化，请重新加载后再删除");
          }
          const token = randomUUID();
          const claimed = this.#database
            .prepare(
              `UPDATE task_delete_leases
              SET lease_token = ?, updated_at = ?, last_error_json = NULL
              WHERE task_id = ? AND lease_token = ?`,
            )
            .run(token, this.#now().toISOString(), taskId, existing.token);
          if (claimed.changes !== 1) {
            throw new AppError("VERSION_CONFLICT", 409, "任务删除执行权已变化，请重新操作");
          }
          this.#appendDeleteEvent(
            existing.operationId,
            taskId,
            identityKey(context.actor.identity),
            "resumed",
            {
              phase: existing.phase,
            },
          );
          return { ...existing, token };
        }

        const visible = this.#taskboard.readTask(taskId, context.actor);
        if (!visible.permissions.canWrite) {
          throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
        }
        this.#assertDeletable(
          visible.status,
          visible.archivedAt,
          visible.version,
          command.expectedVersion,
        );
        this.#assertNoActiveJobs(taskId);
        const snapshot = this.#snapshot(taskId);
        const operationId = randomUUID();
        const token = randomUUID();
        const timestamp = this.#now().toISOString();
        this.#database
          .prepare(
            `INSERT INTO task_delete_leases (
              task_id, lease_token, identity_key, expected_version, snapshot_json, created_at,
              operation_id, phase, idempotency_key, request_hash, request_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'archiving', ?, ?, ?, ?)`,
          )
          .run(
            taskId,
            token,
            identityKey(context.actor.identity),
            command.expectedVersion,
            JSON.stringify(snapshot),
            timestamp,
            operationId,
            context.idempotencyKey,
            requestHash,
            context.requestId ?? null,
            timestamp,
          );
        this.#appendDeleteEvent(
          operationId,
          taskId,
          identityKey(context.actor.identity),
          "started",
          {
            expectedVersion: command.expectedVersion,
          },
        );
        return {
          operationId,
          token,
          principalKey: identityKey(context.actor.identity),
          expectedVersion: command.expectedVersion,
          snapshot,
          phase: "archiving" as const,
          idempotencyKey: context.idempotencyKey,
          requestHash,
          requestId: context.requestId ?? null,
        };
      })
      .immediate();
  }

  #readOperation(taskId: string): TaskDeleteOperation;
  #readOperation(taskId: string, required: false): TaskDeleteOperation | undefined;
  #readOperation(taskId: string, required = true): TaskDeleteOperation | undefined {
    const lease = TaskDeleteLeaseRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT operation_id AS operationId, lease_token AS leaseToken, identity_key AS principalKey,
            expected_version AS expectedVersion, snapshot_json AS snapshotJson, phase,
            idempotency_key AS idempotencyKey, request_hash AS requestHash,
            request_id AS requestId
          FROM task_delete_leases WHERE task_id = ?`,
        )
        .get(taskId),
    );
    if (!lease.success) {
      if (!required) return undefined;
      throw new AppError("VERSION_CONFLICT", 409, "任务删除操作不存在，请重新操作");
    }
    return {
      operationId: lease.data.operationId,
      token: lease.data.leaseToken,
      principalKey: lease.data.principalKey,
      expectedVersion: lease.data.expectedVersion,
      snapshot: parseSnapshot(lease.data.snapshotJson),
      phase: lease.data.phase,
      idempotencyKey: lease.data.idempotencyKey,
      requestHash: lease.data.requestHash,
      requestId: lease.data.requestId,
    };
  }

  #readTaskRow(taskId: string): z.infer<typeof TaskDeleteRowSchema> {
    const row = TaskDeleteRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT project_id AS projectId, status, version, archived_at AS archivedAt
          FROM tasks WHERE id = ?`,
        )
        .get(taskId),
    );
    if (!row.success) throw new AppError("NOT_FOUND", 404, "任务不存在");
    return row.data;
  }

  #snapshot(taskId: string): TaskDeletionSnapshot {
    const attachmentStorageKeys = this.#values(
      "SELECT storage_key AS value FROM attachments WHERE task_id = ? UNION SELECT storage_key AS value FROM job_attachment_snapshots WHERE task_id = ? ORDER BY value",
      taskId,
      taskId,
    );
    const threadIds = this.#values(
      "SELECT thread_id AS value FROM task_threads WHERE task_id = ? ORDER BY thread_id",
      taskId,
    );
    const resourceIds = new Set<string>([taskId]);
    const queries = [
      "SELECT id AS value FROM comments WHERE task_id = ? ORDER BY id",
      "SELECT id AS value FROM attachments WHERE task_id = ? ORDER BY id",
      "SELECT id AS value FROM task_threads WHERE task_id = ? ORDER BY id",
      "SELECT id AS value FROM jobs WHERE task_id = ? ORDER BY id",
      "SELECT id AS value FROM activities WHERE task_id = ? ORDER BY id",
      `SELECT 'task-read:' || identity_key AS value FROM task_reads
        WHERE task_id = ? ORDER BY identity_key`,
      `SELECT 'orphan:' || task_id AS value FROM project_orphaned_tasks
        WHERE task_id = ? ORDER BY task_id`,
      `SELECT job_interactions.id AS value FROM job_interactions
        JOIN jobs ON jobs.id = job_interactions.job_id WHERE jobs.task_id = ?
        ORDER BY job_interactions.id`,
      `SELECT job_events.id AS value FROM job_events
        JOIN jobs ON jobs.id = job_events.job_id WHERE jobs.task_id = ?
        ORDER BY job_events.id`,
      `SELECT id AS value FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ? ORDER BY id`,
      `SELECT 'change:' || CAST(revision AS TEXT) AS value FROM change_events
        WHERE aggregate_id = ? OR json_extract(safe_payload_json, '$.taskId') = ?
        ORDER BY revision`,
      `SELECT 'audit:' || id AS value FROM audit_events
        WHERE resource_id = ? OR json_extract(safe_metadata_json, '$.taskId') = ?
        ORDER BY id`,
    ];
    for (const query of queries) {
      const parameters = query.includes(" OR ") ? [taskId, taskId] : [taskId];
      for (const value of this.#values(query, ...parameters)) resourceIds.add(value);
    }
    return { attachmentStorageKeys, threadIds, resourceIds: [...resourceIds].sort() };
  }

  #values(query: string, ...parameters: readonly string[]): string[] {
    return this.#database
      .prepare(query)
      .all(...parameters)
      .map((row) => StringRowSchema.parse(row).value);
  }

  #deleteRelatedIdempotency(resourceIds: readonly string[], taskId: string): void {
    const removeBySuffix = this.#database.prepare(
      `DELETE FROM request_idempotency
      WHERE scope LIKE ?
        OR json_extract(response_json, '$.task.id') = ?
        OR json_extract(response_json, '$.data.taskId') = ?`,
    );
    for (const resourceId of resourceIds) {
      removeBySuffix.run(`%:${resourceId}`, taskId, taskId);
    }
  }

  #readReplay(
    scope: string,
    context: MutationContext,
    requestHash: string,
  ): DeleteTaskResult | undefined {
    const row = IdempotencyRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT request_hash AS requestHash, response_json AS responseJson
          FROM request_idempotency
          WHERE identity_key = ? AND scope = ? AND idempotency_key = ?`,
        )
        .get(identityKey(context.actor.identity), scope, context.idempotencyKey),
    );
    if (!row.success) return undefined;
    if (row.data.requestHash !== requestHash) {
      throw new AppError("DUPLICATE_REQUEST", 409, "幂等键已用于不同请求");
    }
    return DeleteTaskResultSchema.parse(JSON.parse(row.data.responseJson));
  }

  #markArchiveCompleted(taskId: string, operation: TaskDeleteOperation): TaskDeleteOperation {
    return this.#database
      .transaction(() => {
        const updated = this.#database
          .prepare(
            `UPDATE task_delete_leases
            SET phase = 'finalizing', updated_at = ?, last_error_json = NULL
            WHERE task_id = ? AND operation_id = ? AND lease_token = ? AND phase = 'archiving'`,
          )
          .run(this.#now().toISOString(), taskId, operation.operationId, operation.token);
        if (updated.changes !== 1) {
          throw new AppError("VERSION_CONFLICT", 409, "任务删除执行权已变化，请重新操作");
        }
        this.#appendDeleteEvent(
          operation.operationId,
          taskId,
          operation.principalKey,
          "archive_completed",
          {},
        );
        return { ...operation, phase: "finalizing" as const };
      })
      .immediate();
  }

  #recordFailure(
    taskId: string,
    operation: TaskDeleteOperation,
    eventType: "retry_failed" | "finalize_failed",
    cause: unknown,
  ): void {
    const metadata = failureMetadata(cause);
    this.#database
      .transaction(() => {
        const updated = this.#database
          .prepare(
            `UPDATE task_delete_leases
            SET last_error_json = ?, updated_at = ?
            WHERE task_id = ? AND operation_id = ? AND lease_token = ?`,
          )
          .run(
            JSON.stringify(metadata),
            this.#now().toISOString(),
            taskId,
            operation.operationId,
            operation.token,
          );
        if (updated.changes === 1) {
          this.#appendDeleteEvent(
            operation.operationId,
            taskId,
            operation.principalKey,
            eventType,
            metadata,
          );
        }
      })
      .immediate();
  }

  #storeReplays(
    taskId: string,
    operation: TaskDeleteOperation,
    context: MutationContext,
    result: DeleteTaskResult,
    timestamp: string,
  ): void {
    const requests = [
      ...(operation.idempotencyKey && operation.requestHash
        ? [
            {
              principalKey: operation.principalKey,
              idempotencyKey: operation.idempotencyKey,
              requestHash: operation.requestHash,
            },
          ]
        : []),
      {
        principalKey: identityKey(context.actor.identity),
        idempotencyKey: context.idempotencyKey,
        requestHash: createHash("sha256")
          .update(JSON.stringify({ expectedVersion: operation.expectedVersion }))
          .digest("hex"),
      },
    ];
    const insert = this.#database.prepare(
      `INSERT OR REPLACE INTO request_idempotency (
        identity_key, scope, idempotency_key, request_hash, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const stored = new Set<string>();
    for (const request of requests) {
      const key = `${request.principalKey}:${request.idempotencyKey}`;
      if (stored.has(key)) continue;
      stored.add(key);
      insert.run(
        request.principalKey,
        `task.delete:${taskId}`,
        request.idempotencyKey,
        request.requestHash,
        JSON.stringify(result),
        timestamp,
      );
    }
  }

  #appendDeleteEvent(
    operationId: string,
    taskId: string,
    principalKey: string,
    eventType:
      | "started"
      | "resumed"
      | "archive_completed"
      | "retry_failed"
      | "finalize_failed"
      | "completed",
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO task_delete_events (
          id, operation_id, task_id, identity_key, event_type, safe_metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        operationId,
        taskId,
        principalKey,
        eventType,
        JSON.stringify(metadata),
        this.#now().toISOString(),
      );
  }

  #discardQuarantine(quarantine: QuarantinedAttachments): void {
    try {
      this.#vault.discard(quarantine);
    } catch {
      // The database deletion is committed. Inaccessible quarantined bytes can be
      // cleaned by an operations pass without reviving the deleted records.
    }
  }
}

function parseSnapshot(snapshotJson: string): TaskDeletionSnapshot {
  return z
    .object({
      attachmentStorageKeys: z.array(z.string()),
      threadIds: z.array(z.string()),
      resourceIds: z.array(z.string()),
    })
    .parse(JSON.parse(snapshotJson));
}

function failureMetadata(cause: unknown): Readonly<Record<string, unknown>> {
  if (cause instanceof CodexRequestError)
    return {
      errorType: cause.name,
      rpcCode: cause.code,
      writerConflict: /^thread .+ already has an active writer$/.test(cause.message),
    };
  if (cause instanceof AppError) return { code: cause.code, statusCode: cause.statusCode };
  if (cause instanceof Error) return { errorType: cause.name };
  return { errorType: "UnknownError" };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSnapshot(left: TaskDeletionSnapshot, right: TaskDeletionSnapshot): boolean {
  return (
    sameValues(left.attachmentStorageKeys, right.attachmentStorageKeys) &&
    sameValues(left.threadIds, right.threadIds) &&
    sameValues(left.resourceIds, right.resourceIds)
  );
}
