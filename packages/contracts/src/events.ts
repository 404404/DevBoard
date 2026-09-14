import { z } from "zod";

import { EntityIdSchema, IsoTimestampSchema, RevisionSchema } from "./common.js";

export const AggregateTypeSchema = z.enum([
  "project",
  "task",
  "comment",
  "attachment",
  "job",
  "interaction",
  "system",
]);

export const BoardEventSchema = z.object({
  revision: RevisionSchema,
  aggregateType: AggregateTypeSchema,
  aggregateId: EntityIdSchema.nullable(),
  eventType: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i),
  safePayload: z.record(z.string(), z.unknown()),
  createdAt: IsoTimestampSchema,
});

export const EventFeedQuerySchema = z.object({
  projectId: EntityIdSchema,
  afterRevision: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const EventPageSchema = z.object({
  events: z.array(BoardEventSchema),
  latestRevision: RevisionSchema,
  cursorRevision: RevisionSchema,
  earliestAvailableRevision: RevisionSchema,
  hasMore: z.boolean(),
  historyTruncated: z.boolean(),
  cursorAhead: z.boolean(),
});

export const EventStreamMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change"),
    revision: RevisionSchema,
    event: BoardEventSchema,
  }),
  z.object({
    kind: z.literal("cursor"),
    revision: RevisionSchema,
  }),
  z.object({
    kind: z.literal("refresh_required"),
    revision: RevisionSchema,
    reason: z.enum(["history_truncated", "cursor_ahead"]),
  }),
]);

export type BoardEvent = z.infer<typeof BoardEventSchema>;
export type EventFeedQuery = z.infer<typeof EventFeedQuerySchema>;
export type EventPage = z.infer<typeof EventPageSchema>;
export type EventStreamMessage = z.infer<typeof EventStreamMessageSchema>;
