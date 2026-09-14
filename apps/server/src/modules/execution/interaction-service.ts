import { identityKey, identityFromKey, IdentityKeySchema } from "@lark-taskboard/contracts";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import {
  InteractionDecisionSchema,
  InteractionViewSchema,
  type PrincipalView,
  type InteractionDecision,
  type InteractionView,
} from "@lark-taskboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import type { IdentityService } from "../identity/index.js";
import type { ExecutionQueue } from "./execution-queue.js";

const SUPPORTED_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
]);

const RawInteractionRowSchema = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  serverRequestId: z.string(),
  kind: z.enum(["command_approval", "file_change_approval", "user_input", "other"]),
  status: z.enum(["pending", "responded", "expired", "canceled"]),
  safeRequestJson: z.string(),
  decisionJson: z.string().nullable(),
  decidedBy: IdentityKeySchema.nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
});

interface OpenInteractionRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export interface PendingInteraction {
  readonly interaction: InteractionView;
  readonly decision: Promise<InteractionDecision>;
}

interface InteractionServiceOptions {
  readonly database: SqliteDatabase;
  readonly queue: ExecutionQueue;
  readonly identityService: IdentityService;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
}

export class InteractionService {
  readonly #database: SqliteDatabase;
  readonly #queue: ExecutionQueue;
  readonly #identityService: IdentityService;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;
  readonly #responders = new Map<
    string,
    { resolve: (decision: InteractionDecision) => void; reject: (error: Error) => void }
  >();

  constructor(options: InteractionServiceOptions) {
    this.#database = options.database;
    this.#queue = options.queue;
    this.#identityService = options.identityService;
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
  }

  open(jobId: string, owner: string, request: OpenInteractionRequest): PendingInteraction {
    if (!SUPPORTED_METHODS.has(request.method)) {
      throw new AppError(
        "INVALID_REQUEST",
        409,
        `不支持的 Codex Server Request: ${request.method}`,
      );
    }
    const job = this.#queue.readJob(jobId);
    const serverRequestId = String(request.id);
    const existingId = this.#database
      .prepare("SELECT id FROM job_interactions WHERE job_id = ? AND server_request_id = ?")
      .pluck()
      .get(jobId, serverRequestId) as string | undefined;
    let interaction: InteractionView;
    if (existingId) {
      interaction = this.read(existingId);
      if (interaction.status !== "pending") {
        throw new AppError("INVALID_REQUEST", 409, "该 Codex 请求已经处理");
      }
    } else {
      const timestamp = this.#now().toISOString();
      const interactionId = randomUUID();
      const kind = this.#kind(request.method);
      const safeRequest = {
        requestMethod: request.method,
        ...this.#safeRequest(request.method, request.params),
      };
      const revision = withTransaction(this.#database, () => {
        this.#database
          .prepare(
            `INSERT INTO job_interactions (
              id, job_id, server_request_id, kind, status, safe_request_json, created_at
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(interactionId, jobId, serverRequestId, kind, JSON.stringify(safeRequest), timestamp);
        const result = this.#database
          .prepare(
            `INSERT INTO change_events (
              aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
            ) VALUES ('interaction', ?, 'interaction.requested', ?, ?)`,
          )
          .run(
            interactionId,
            JSON.stringify({ taskId: job.taskId, jobId, kind, status: "pending" }),
            timestamp,
          );
        return Number(result.lastInsertRowid);
      });
      this.#queue.waitForInteraction(
        jobId,
        owner,
        kind === "user_input" ? "waiting_input" : "waiting_approval",
      );
      this.#onRevisionCommitted?.(revision);
      interaction = this.read(interactionId);
    }

    const decision = new Promise<InteractionDecision>((resolve, reject) => {
      this.#responders.set(interaction.id, { resolve, reject });
    });
    return { interaction, decision };
  }

  read(interactionId: string): InteractionView {
    const row = RawInteractionRowSchema.safeParse(
      this.#database
        .prepare(
          `SELECT id, job_id AS jobId, server_request_id AS serverRequestId, kind, status,
            safe_request_json AS safeRequestJson, decision_json AS decisionJson,
            decided_by_identity_key AS decidedBy, created_at AS createdAt, decided_at AS decidedAt
          FROM job_interactions WHERE id = ?`,
        )
        .get(interactionId),
    );
    if (!row.success) {
      throw new AppError("NOT_FOUND", 404, "Codex 交互不存在");
    }
    const safeRequest = JSON.parse(row.data.safeRequestJson) as Record<string, unknown>;
    const { requestMethod, ...requestFields } = safeRequest;
    return InteractionViewSchema.parse({
      ...row.data,
      decidedBy: row.data.decidedBy ? identityFromKey(row.data.decidedBy) : null,
      requestMethod,
      safeRequest: requestFields,
      decision: row.data.decisionJson ? JSON.parse(row.data.decisionJson) : null,
    });
  }

  listForJob(jobId: string): readonly InteractionView[] {
    const ids = this.#database
      .prepare("SELECT id FROM job_interactions WHERE job_id = ? ORDER BY created_at, rowid")
      .pluck()
      .all(jobId) as string[];
    return ids.map((id) => this.read(id));
  }

  respond(
    interactionId: string,
    decisionInput: InteractionDecision,
    actor: PrincipalView,
    requestId?: string,
  ): InteractionView {
    const decision = InteractionDecisionSchema.parse(decisionInput);
    const current = this.read(interactionId);
    const job = this.#queue.readJob(current.jobId);
    const projectId = this.#database
      .prepare("SELECT project_id FROM tasks WHERE id = ?")
      .pluck()
      .get(job.taskId) as string;
    this.#identityService.authorizeProject(actor, projectId, "execute");
    if (current.kind === "user_input" && decision.type !== "input" && decision.type !== "cancel") {
      throw new AppError("INVALID_REQUEST", 400, "用户输入请求只能提交文本或取消");
    }
    if (current.kind !== "user_input" && decision.type === "input") {
      throw new AppError("INVALID_REQUEST", 400, "审批请求不能提交文本输入");
    }
    const timestamp = this.#now().toISOString();
    const storedDecision =
      decision.type === "input"
        ? {
            type: "input",
            answers: Object.fromEntries(
              Object.entries(decision.answers).map(([key, answers]) => [
                key,
                answers.map(() => "[已提交]"),
              ]),
            ),
          }
        : decision;
    const revision = withTransaction(this.#database, () => {
      const update = this.#database
        .prepare(
          `UPDATE job_interactions SET status = 'responded', decision_json = ?,
            decided_by_identity_key = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(JSON.stringify(storedDecision), identityKey(actor.identity), timestamp, interactionId);
      if (update.changes !== 1) {
        throw new AppError("VERSION_CONFLICT", 409, "该 Codex 请求已被其他成员处理");
      }
      this.#database
        .prepare(
          `INSERT INTO audit_events (
            id, identity_key, action, resource_type, resource_id, outcome,
            request_id, safe_metadata_json, created_at
          ) VALUES (?, ?, 'interaction.respond', 'interaction', ?, 'allowed', ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          identityKey(actor.identity),
          interactionId,
          requestId ?? null,
          JSON.stringify({ jobId: job.id, decision: decision.type }),
          timestamp,
        );
      const result = this.#database
        .prepare(
          `INSERT INTO change_events (
            aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
          ) VALUES ('interaction', ?, 'interaction.responded', ?, ?)`,
        )
        .run(
          interactionId,
          JSON.stringify({ taskId: job.taskId, jobId: job.id, status: "responded" }),
          timestamp,
        );
      return Number(result.lastInsertRowid);
    });
    const responder = this.#responders.get(interactionId);
    if (!responder) {
      throw new AppError(
        "UPSTREAM_ERROR",
        502,
        "决定已保存，但 Codex 连接已中断；请从失败作业重试",
      );
    }
    this.#responders.delete(interactionId);
    responder.resolve(decision);
    this.#onRevisionCommitted?.(revision);
    return this.read(interactionId);
  }

  markDelivered(interactionId: string, owner: string): void {
    const interaction = this.read(interactionId);
    this.#queue.resumeAfterInteraction(interaction.jobId, owner);
  }

  expirePending(reason = "Codex 连接已中断"): number {
    const timestamp = this.#now().toISOString();
    const pending = this.#database
      .prepare("SELECT id FROM job_interactions WHERE status = 'pending'")
      .pluck()
      .all() as string[];
    for (const id of pending) {
      this.#database
        .prepare(
          `UPDATE job_interactions SET status = 'expired', decision_json = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
        )
        .run(JSON.stringify({ type: "cancel", reason }), timestamp, id);
      this.#responders.get(id)?.reject(new AppError("UPSTREAM_ERROR", 502, reason));
      this.#responders.delete(id);
    }
    return pending.length;
  }

  cancelForJob(jobId: string): number {
    const timestamp = this.#now().toISOString();
    const pending = this.#database
      .prepare("SELECT id FROM job_interactions WHERE job_id = ? AND status = 'pending'")
      .pluck()
      .all(jobId) as string[];
    for (const id of pending) {
      this.#database
        .prepare(
          `UPDATE job_interactions SET status = 'canceled', decision_json = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
        )
        .run(JSON.stringify({ type: "cancel" }), timestamp, id);
      this.#responders.get(id)?.reject(new AppError("INVALID_REQUEST", 409, "执行已取消"));
      this.#responders.delete(id);
    }
    return pending.length;
  }

  #kind(method: string): InteractionView["kind"] {
    if (method === "item/commandExecution/requestApproval") return "command_approval";
    if (method === "item/fileChange/requestApproval") return "file_change_approval";
    if (method === "execCommandApproval") return "command_approval";
    if (method === "applyPatchApproval") return "file_change_approval";
    if (method === "item/tool/requestUserInput") return "user_input";
    return "other";
  }

  #safeRequest(method: string, params: unknown): Record<string, unknown> {
    const value = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      const rawCommandActions = Array.isArray(value.commandActions)
        ? value.commandActions.slice(0, 20)
        : [];
      const commandActions = rawCommandActions.flatMap((action) => {
        const item =
          action && typeof action === "object" ? (action as Record<string, unknown>) : {};
        return typeof item.command === "string"
          ? [
              {
                command: item.command.slice(0, 2_000),
                type: typeof item.type === "string" ? item.type.slice(0, 50) : "unknown",
              },
            ]
          : [];
      });
      return {
        command:
          typeof value.command === "string"
            ? value.command.slice(0, 2_000)
            : Array.isArray(value.command)
              ? value.command.map(String).join(" ").slice(0, 2_000)
              : "",
        commandActions,
        commandActionCount: rawCommandActions.length,
        commandActionsComplete: commandActions.length === rawCommandActions.length,
        reason: typeof value.reason === "string" ? value.reason.slice(0, 500) : null,
      };
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      return {
        reason: typeof value.reason === "string" ? value.reason.slice(0, 500) : null,
        writeScope:
          typeof value.grantRoot === "string" ? basename(value.grantRoot) : "当前工作目录",
      };
    }
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(value.questions) ? value.questions : [];
      return {
        questions: questions.slice(0, 3).map((question) => {
          const item = question as Record<string, unknown>;
          return {
            id: String(item.id ?? ""),
            header: String(item.header ?? "").slice(0, 100),
            question: String(item.question ?? "").slice(0, 1_000),
            isSecret: item.isSecret === true,
            options: Array.isArray(item.options) ? item.options.slice(0, 10) : null,
          };
        }),
      };
    }
    return {
      reason: typeof value.reason === "string" ? value.reason.slice(0, 500) : null,
      requestType: method.split("/").slice(0, 2).join("/"),
    };
  }
}
