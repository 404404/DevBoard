import { z } from "zod";

export const ModelsSchema = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      hidden: z.boolean().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
      defaultReasoningEffort: z.string(),
      serviceTiers: z
        .array(z.object({ id: z.string(), name: z.string(), description: z.string().nullish() }))
        .default([]),
    }),
  ),
});
