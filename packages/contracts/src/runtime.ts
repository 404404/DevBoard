import { z } from "zod";

import { IsoTimestampSchema } from "./common.js";

export const RuntimeCapabilitySchema = z.string().min(43).max(200);

export const RuntimeDescriptorSchema = z.object({
  descriptorVersion: z.literal(1),
  pid: z.number().int().positive(),
  generatedAt: IsoTimestampSchema,
  publicBaseUrl: z.url(),
  localAdminBaseUrl: z.url(),
  capabilityToken: RuntimeCapabilitySchema,
});

export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>;
