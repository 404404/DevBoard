import { identityKey } from "@lark-codex/contracts";
import { createHash, randomUUID } from "node:crypto";

import {
  GlobalLabelListViewSchema,
  GlobalLabelViewSchema,
  type PrincipalView,
  type CreateGlobalLabelCommand,
  type DeleteGlobalLabelCommand,
  type GlobalLabelListView,
  type GlobalLabelView,
  type ReorderGlobalLabelsCommand,
  type UpdateGlobalLabelCommand,
} from "@lark-codex/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import type { MutationContext } from "../taskboard/index.js";
import { assertBoardAccess } from "../identity/identity-policy.js";
import { assertTaskDeletionAvailable } from "../taskboard/task-delete-lease.js";

const IdempotencyRowSchema = z.object({
  requestHash: z.string().length(64),
  responseJson: z.string(),
});

const TaskLabelsRowSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  identifier: z.string(),
  title: z.string(),
  labelsJson: z.string(),
  version: z.number().int().positive(),
});

interface LabelCatalogOptions {
  readonly database: SqliteDatabase;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
}

export interface GlobalLabelMutationResult {
  readonly label: GlobalLabelView;
  readonly revision: number;
}

export interface GlobalLabelDeleteResult {
  readonly labelId: string;
  readonly revision: number;
}

export interface GlobalLabelOrderResult {
  readonly labels: readonly GlobalLabelView[];
  readonly revision: number;
}

const LABEL_COLUMNS = `
  id,
  name,
  sort_order AS sortOrder,
  version,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export class LabelCatalog {
  readonly #database: SqliteDatabase;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;

  constructor(options: LabelCatalogOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
  }

  list(actor: PrincipalView): GlobalLabelListView {
    assertBoardAccess(this.#database, actor);
    const rows: unknown[] = this.#database
      .prepare(`SELECT ${LABEL_COLUMNS} FROM global_labels ORDER BY sort_order, id`)
      .all();
    return GlobalLabelListViewSchema.parse({
      labels: rows.map((row) => GlobalLabelViewSchema.parse(row)),
    });
  }

  create(command: CreateGlobalLabelCommand, context: MutationContext): GlobalLabelMutationResult {
    assertBoardAccess(this.#database, context.actor);
    return this.#idempotentMutation("label.create", command, context, () => {
      if (this.#findByName(command.name)) {
        throw new AppError("DUPLICATE_REQUEST", 409, "标签名称已存在");
      }
      const timestamp = this.#now().toISOString();
      const labelId = randomUUID();
      const sortOrder = this.#database
        .prepare("SELECT coalesce(max(sort_order), -1) + 1 FROM global_labels")
        .pluck()
        .get() as number;
      this.#database
        .prepare(
          `INSERT INTO global_labels (
            id, name, sort_order, version, created_by_identity_key, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          labelId,
          command.name,
          sortOrder,
          identityKey(context.actor.identity),
          timestamp,
          timestamp,
        );
      const label = this.#readLabel(labelId);
      const revision = this.#recordProjectEvents("label.created", labelId, label.name, timestamp);
      this.#recordAudit("label.create", labelId, context, { name: label.name }, timestamp);
      return { label, revision };
    });
  }

  update(
    labelId: string,
    command: UpdateGlobalLabelCommand,
    context: MutationContext,
  ): GlobalLabelMutationResult {
    assertBoardAccess(this.#database, context.actor);
    return this.#idempotentMutation(`label.update:${labelId}`, command, context, () => {
      const current = this.#readLabel(labelId);
      const duplicate = this.#findByName(command.name);
      if (duplicate && duplicate.id !== labelId) {
        throw new AppError("DUPLICATE_REQUEST", 409, "标签名称已存在");
      }
      const timestamp = this.#now().toISOString();
      const changed = this.#database
        .prepare(
          `UPDATE global_labels
          SET name = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
        )
        .run(command.name, timestamp, labelId, command.expectedVersion);
      if (changed.changes !== 1) {
        throw new AppError("VERSION_CONFLICT", 409, "标签版本已变化，请重新加载");
      }
      this.#replaceTaskLabel(current.name, command.name, context, timestamp);
      const label = this.#readLabel(labelId);
      const revision = this.#recordProjectEvents("label.updated", labelId, label.name, timestamp);
      this.#recordAudit(
        "label.update",
        labelId,
        context,
        { previousName: current.name, name: label.name },
        timestamp,
      );
      return { label, revision };
    });
  }

  delete(
    labelId: string,
    command: DeleteGlobalLabelCommand,
    context: MutationContext,
  ): GlobalLabelDeleteResult {
    assertBoardAccess(this.#database, context.actor);
    return this.#idempotentMutation(`label.delete:${labelId}`, command, context, () => {
      const current = this.#readLabel(labelId);
      if (current.version !== command.expectedVersion) {
        throw new AppError("VERSION_CONFLICT", 409, "标签版本已变化，请重新加载");
      }
      const timestamp = this.#now().toISOString();
      this.#replaceTaskLabel(current.name, null, context, timestamp);
      const removed = this.#database
        .prepare("DELETE FROM global_labels WHERE id = ? AND version = ?")
        .run(labelId, command.expectedVersion);
      if (removed.changes !== 1) {
        throw new AppError("VERSION_CONFLICT", 409, "标签版本已变化，请重新加载");
      }
      this.#compactSortOrder(timestamp);
      const revision = this.#recordProjectEvents("label.deleted", labelId, current.name, timestamp);
      this.#recordAudit("label.delete", labelId, context, { name: current.name }, timestamp);
      return { labelId, revision };
    });
  }

  reorder(command: ReorderGlobalLabelsCommand, context: MutationContext): GlobalLabelOrderResult {
    assertBoardAccess(this.#database, context.actor);
    return this.#idempotentMutation("label.reorder", command, context, () => {
      const current = this.list(context.actor).labels;
      if (
        command.labelIds.length !== current.length ||
        new Set(command.labelIds).size !== current.length ||
        current.some((label) => !command.labelIds.includes(label.id))
      ) {
        throw new AppError("INVALID_REQUEST", 400, "标签排序必须包含完整且唯一的标签列表");
      }
      const timestamp = this.#now().toISOString();
      this.#database.prepare("UPDATE global_labels SET sort_order = sort_order + 1000000").run();
      const update = this.#database.prepare(
        "UPDATE global_labels SET sort_order = ?, updated_at = ? WHERE id = ?",
      );
      command.labelIds.forEach((id, index) => update.run(index, timestamp, id));
      const revision = this.#recordProjectEvents("label.reordered", null, null, timestamp);
      this.#recordAudit("label.reorder", null, context, { labelIds: command.labelIds }, timestamp);
      return { labels: this.list(context.actor).labels, revision };
    });
  }

  #replaceTaskLabel(
    previousName: string,
    nextName: string | null,
    context: MutationContext,
    timestamp: string,
  ): void {
    const rows: unknown[] = this.#database
      .prepare(
        `SELECT id, project_id AS projectId, identifier, title, labels_json AS labelsJson, version
        FROM tasks
        WHERE EXISTS (
          SELECT 1 FROM json_each(tasks.labels_json) WHERE value = ? COLLATE BINARY
        )`,
      )
      .all(previousName);
    for (const raw of rows) {
      const task = TaskLabelsRowSchema.parse(raw);
      assertTaskDeletionAvailable(this.#database, task.id);
      const labels = z.array(z.string()).parse(JSON.parse(task.labelsJson));
      const updatedLabels = nextName
        ? labels.map((label) => (label === previousName ? nextName : label))
        : labels.filter((label) => label !== previousName);
      this.#database
        .prepare(
          `UPDATE tasks SET labels_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(updatedLabels), timestamp, task.id);
      this.#database
        .prepare(
          `INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at)
          VALUES (?, ?, ?, 'task.labels.updated', ?, ?)`,
        )
        .run(
          randomUUID(),
          task.id,
          identityKey(context.actor.identity),
          JSON.stringify({ from: previousName, to: nextName }),
          timestamp,
        );
      this.#database
        .prepare(
          `INSERT INTO change_events (
            aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
          ) VALUES ('task', ?, 'task.updated', ?, ?)`,
        )
        .run(
          task.id,
          JSON.stringify({
            projectId: task.projectId,
            identifier: task.identifier,
            title: task.title,
            version: task.version + 1,
          }),
          timestamp,
        );
    }
  }

  #compactSortOrder(timestamp: string): void {
    const ids = this.#database
      .prepare("SELECT id FROM global_labels ORDER BY sort_order, id")
      .pluck()
      .all() as string[];
    this.#database.prepare("UPDATE global_labels SET sort_order = sort_order + 1000000").run();
    const update = this.#database.prepare(
      "UPDATE global_labels SET sort_order = ?, updated_at = ? WHERE id = ?",
    );
    ids.forEach((id, index) => update.run(index, timestamp, id));
  }

  #recordProjectEvents(
    eventType: "label.created" | "label.updated" | "label.deleted" | "label.reordered",
    labelId: string | null,
    name: string | null,
    timestamp: string,
  ): number {
    const projectIds = this.#database
      .prepare(
        `SELECT id FROM projects
        WHERE archived_at IS NULL
          AND (source_kind != 'codex' OR sync_deleted_at IS NULL)
        ORDER BY id`,
      )
      .pluck()
      .all() as string[];
    let revision = 0;
    const insert = this.#database.prepare(
      `INSERT INTO change_events (
        aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
      ) VALUES ('system', ?, ?, ?, ?)`,
    );
    for (const projectId of projectIds) {
      const result = insert.run(
        labelId,
        eventType,
        JSON.stringify({ projectId, labelId, name }),
        timestamp,
      );
      revision = Number(result.lastInsertRowid);
    }
    return revision;
  }

  #recordAudit(
    action: string,
    labelId: string | null,
    context: MutationContext,
    metadata: Record<string, unknown>,
    timestamp: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome,
          request_id, safe_metadata_json, created_at
        ) VALUES (?, ?, ?, 'label', ?, 'allowed', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        identityKey(context.actor.identity),
        action,
        labelId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        timestamp,
      );
  }

  #readLabel(labelId: string): GlobalLabelView {
    const raw: unknown = this.#database
      .prepare(`SELECT ${LABEL_COLUMNS} FROM global_labels WHERE id = ?`)
      .get(labelId);
    if (!raw) throw new AppError("NOT_FOUND", 404, "标签不存在");
    return GlobalLabelViewSchema.parse(raw);
  }

  #findByName(name: string): GlobalLabelView | null {
    const raw: unknown = this.#database
      .prepare(`SELECT ${LABEL_COLUMNS} FROM global_labels WHERE name = ? COLLATE BINARY`)
      .get(name);
    return raw ? GlobalLabelViewSchema.parse(raw) : null;
  }

  #idempotentMutation<Result extends { readonly revision: number }>(
    scope: string,
    request: unknown,
    context: MutationContext,
    operation: () => Result,
  ): Result {
    const requestHash = createHash("sha256").update(stableStringify(request)).digest("hex");
    const outcome = withTransaction(this.#database, () => {
      const existingRaw: unknown = this.#database
        .prepare(
          `SELECT request_hash AS requestHash, response_json AS responseJson
          FROM request_idempotency
          WHERE identity_key = ? AND scope = ? AND idempotency_key = ?`,
        )
        .get(identityKey(context.actor.identity), scope, context.idempotencyKey);
      const existing = IdempotencyRowSchema.safeParse(existingRaw);
      if (existing.success) {
        if (existing.data.requestHash !== requestHash) {
          throw new AppError("DUPLICATE_REQUEST", 409, "幂等键已用于不同请求");
        }
        return { result: JSON.parse(existing.data.responseJson) as Result, committed: false };
      }
      const result = operation();
      this.#database
        .prepare(
          `INSERT INTO request_idempotency (
            identity_key, scope, idempotency_key, request_hash, response_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identityKey(context.actor.identity),
          scope,
          context.idempotencyKey,
          requestHash,
          JSON.stringify(result),
          this.#now().toISOString(),
        );
      return { result, committed: true };
    });
    if (outcome.committed) this.#onRevisionCommitted?.(outcome.result.revision);
    return outcome.result;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
