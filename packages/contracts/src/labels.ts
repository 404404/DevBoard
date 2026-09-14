import { z } from "zod";

import { EntityIdSchema, EntityVersionSchema, IsoTimestampSchema } from "./common.js";

export const GlobalLabelNameSchema = z.string().trim().min(1).max(40);

export const GlobalLabelViewSchema = z.object({
  id: EntityIdSchema,
  name: GlobalLabelNameSchema,
  sortOrder: z.number().int().nonnegative(),
  version: EntityVersionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const GlobalLabelListViewSchema = z.object({
  labels: z.array(GlobalLabelViewSchema),
});

export const CreateGlobalLabelCommandSchema = z.object({
  name: GlobalLabelNameSchema,
});

export const UpdateGlobalLabelCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
  name: GlobalLabelNameSchema,
});

export const DeleteGlobalLabelCommandSchema = z.object({
  expectedVersion: EntityVersionSchema,
});

export const ReorderGlobalLabelsCommandSchema = z
  .object({
    labelIds: z.array(EntityIdSchema),
  })
  .superRefine((command, context) => {
    if (new Set(command.labelIds).size !== command.labelIds.length) {
      context.addIssue({ code: "custom", message: "标签排序不能包含重复标签" });
    }
  });

export type GlobalLabelView = z.infer<typeof GlobalLabelViewSchema>;
export type GlobalLabelListView = z.infer<typeof GlobalLabelListViewSchema>;
export type CreateGlobalLabelCommand = z.infer<typeof CreateGlobalLabelCommandSchema>;
export type UpdateGlobalLabelCommand = z.infer<typeof UpdateGlobalLabelCommandSchema>;
export type DeleteGlobalLabelCommand = z.infer<typeof DeleteGlobalLabelCommandSchema>;
export type ReorderGlobalLabelsCommand = z.infer<typeof ReorderGlobalLabelsCommandSchema>;
