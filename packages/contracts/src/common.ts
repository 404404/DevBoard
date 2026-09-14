import { z } from "zod";

export const EntityIdSchema = z.uuid();
export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const EntityVersionSchema = z.number().int().positive();
export const RevisionSchema = z.number().int().nonnegative();
export const IdempotencyKeySchema = z.string().trim().min(8).max(200);

export const PaginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PaginationMetaSchema = z.object({
  nextCursor: z.string().min(1).optional(),
  hasMore: z.boolean(),
});

export const ExpectedVersionSchema = z.object({
  expectedVersion: EntityVersionSchema,
});

export type EntityId = z.infer<typeof EntityIdSchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;
