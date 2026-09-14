import {
  BoardEventSchema,
  EventFeedQuerySchema,
  EventPageSchema,
  EventStreamMessageSchema,
  RevisionSchema,
  type BoardEvent,
  type EventFeedQuery,
  type EventPage,
  type EventStreamMessage,
} from "@lark-taskboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";

const RawEventRowSchema = z.object({
  revision: z.number().int().positive(),
  aggregateType: z.enum([
    "project",
    "task",
    "comment",
    "attachment",
    "job",
    "interaction",
    "system",
  ]),
  aggregateId: z.uuid().nullable(),
  eventType: z.string(),
  safePayloadJson: z.string(),
  createdAt: z.string().datetime(),
});

export interface EventFeedOptions {
  readonly database: SqliteDatabase;
  readonly historyLimit?: number;
  readonly subscriptionPageSize?: number;
}

export interface EventSubscriptionOptions {
  readonly projectId: string;
  readonly afterRevision: number;
  readonly signal?: AbortSignal;
}

class RevisionSignal {
  #closed = false;
  #pendingRevision: number | undefined;
  #waiter: ((revision: number | null) => void) | undefined;

  notify(revision: number): void {
    if (this.#closed) {
      return;
    }
    this.#pendingRevision = Math.max(this.#pendingRevision ?? 0, revision);
    if (this.#waiter) {
      const waiter = this.#waiter;
      const pendingRevision = this.#pendingRevision;
      this.#waiter = undefined;
      this.#pendingRevision = undefined;
      waiter(pendingRevision);
    }
  }

  wait(): Promise<number | null> {
    if (this.#pendingRevision !== undefined) {
      const pendingRevision = this.#pendingRevision;
      this.#pendingRevision = undefined;
      return Promise.resolve(pendingRevision);
    }
    if (this.#closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#pendingRevision = undefined;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.(null);
  }
}

export class EventFeed {
  readonly #database: SqliteDatabase;
  readonly #historyLimit: number;
  readonly #subscriptionPageSize: number;
  readonly #subscribers = new Set<RevisionSignal>();
  #closed = false;

  constructor(options: EventFeedOptions) {
    this.#database = options.database;
    this.#historyLimit = Math.max(1, options.historyLimit ?? 10_000);
    this.#subscriptionPageSize = Math.min(200, Math.max(1, options.subscriptionPageSize ?? 100));
  }

  readSince(input: EventFeedQuery): EventPage {
    const query = EventFeedQuerySchema.parse(input);
    this.#assertProjectExists(query.projectId);
    const latestRevision = this.#latestRevision();
    const earliestAvailableRevision =
      latestRevision === 0 ? 0 : Math.max(1, latestRevision - this.#historyLimit + 1);
    const historyTruncated =
      latestRevision > 0 && query.afterRevision < earliestAvailableRevision - 1;
    const cursorAhead = query.afterRevision > latestRevision;

    if (historyTruncated || cursorAhead) {
      return EventPageSchema.parse({
        events: [],
        latestRevision,
        cursorRevision: latestRevision,
        earliestAvailableRevision,
        hasMore: false,
        historyTruncated,
        cursorAhead,
      });
    }

    const rows: unknown[] = this.#database
      .prepare(
        `SELECT
          revision,
          aggregate_type AS aggregateType,
          aggregate_id AS aggregateId,
          event_type AS eventType,
          safe_payload_json AS safePayloadJson,
          created_at AS createdAt
        FROM change_events
        WHERE revision > ?
          AND revision <= ?
          AND json_extract(safe_payload_json, '$.projectId') = ?
        ORDER BY revision
        LIMIT ?`,
      )
      .all(query.afterRevision, latestRevision, query.projectId, query.limit + 1);
    const events = rows.slice(0, query.limit).map((row) => this.#boardEvent(row));
    const hasMore = rows.length > query.limit;
    const cursorRevision = hasMore
      ? (events.at(-1)?.revision ?? query.afterRevision)
      : latestRevision;

    return EventPageSchema.parse({
      events,
      latestRevision,
      cursorRevision,
      earliestAvailableRevision,
      hasMore,
      historyTruncated: false,
      cursorAhead: false,
    });
  }

  subscribe(options: EventSubscriptionOptions): AsyncIterable<EventStreamMessage> {
    return this.#subscribe(options);
  }

  notifyCommitted(revision: number): void {
    const parsedRevision = RevisionSchema.parse(revision);
    if (this.#closed) {
      return;
    }
    for (const subscriber of this.#subscribers) {
      subscriber.notify(parsedRevision);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.close();
    }
    this.#subscribers.clear();
  }

  async *#subscribe(options: EventSubscriptionOptions): AsyncGenerator<EventStreamMessage> {
    if (this.#closed) {
      return;
    }
    const initialQuery = EventFeedQuerySchema.parse({
      projectId: options.projectId,
      afterRevision: options.afterRevision,
      limit: this.#subscriptionPageSize,
    });
    const revisionSignal = new RevisionSignal();
    const abort = () => revisionSignal.close();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.#subscribers.add(revisionSignal);
    let cursor = initialQuery.afterRevision;

    try {
      while (!options.signal?.aborted) {
        const page = this.readSince({
          projectId: initialQuery.projectId,
          afterRevision: cursor,
          limit: initialQuery.limit,
        });
        if (page.historyTruncated || page.cursorAhead) {
          yield EventStreamMessageSchema.parse({
            kind: "refresh_required",
            revision: page.latestRevision,
            reason: page.cursorAhead ? "cursor_ahead" : "history_truncated",
          });
          return;
        }

        for (const event of page.events) {
          if (event.revision <= cursor) {
            continue;
          }
          cursor = event.revision;
          yield EventStreamMessageSchema.parse({
            kind: "change",
            revision: event.revision,
            event,
          });
        }
        if (page.cursorRevision > cursor) {
          cursor = page.cursorRevision;
          yield EventStreamMessageSchema.parse({ kind: "cursor", revision: cursor });
        }
        if (page.hasMore) {
          continue;
        }

        const notifiedRevision = await revisionSignal.wait();
        if (notifiedRevision === null) {
          return;
        }
        if (notifiedRevision <= cursor) {
          continue;
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      revisionSignal.close();
      this.#subscribers.delete(revisionSignal);
    }
  }

  #latestRevision(): number {
    return Number(
      this.#database.prepare("SELECT coalesce(max(revision), 0) FROM change_events").pluck().get(),
    );
  }

  #assertProjectExists(projectId: string): void {
    const exists = this.#database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!exists) {
      throw new AppError("NOT_FOUND", 404, "项目不存在");
    }
  }

  #boardEvent(raw: unknown): BoardEvent {
    const row = RawEventRowSchema.parse(raw);
    const safePayload: unknown = JSON.parse(row.safePayloadJson);
    return BoardEventSchema.parse({ ...row, safePayload });
  }
}
