import { z } from "zod";

import { IsoTimestampSchema } from "./common.js";
import { ActorRoleSchema } from "./domain.js";

export const ExchangeFeishuCodeSchema = z.object({
  code: z.string().trim().min(8).max(2_048),
});

export const AuthBootstrapSchema = z.discriminatedUnion("authMode", [
  z.object({ authMode: z.literal("web"), feishuAppId: z.null(), webLoginEnabled: z.boolean() }),
  z.object({ authMode: z.literal("development"), feishuAppId: z.null() }),
  z.object({
    authMode: z.literal("feishu"),
    feishuAppId: z.string().trim().min(1),
    webLoginEnabled: z.boolean().default(false),
  }),
]);

const IdentityPartSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value, "身份字段不能包含首尾空白");

export const FeishuIdentityRefSchema = z.strictObject({
  kind: z.literal("feishu"),
  tenantKey: IdentityPartSchema,
  userId: IdentityPartSchema,
});

export const ServiceIdentityRefSchema = z.strictObject({
  kind: z.literal("service"),
  serviceId: z.enum(["local-admin", "codex"]),
});

export const WebIdentityRefSchema = z.strictObject({ kind: z.literal("web"), accountId: z.uuid() });
export const UserIdentityRefSchema = z.discriminatedUnion("kind", [
  FeishuIdentityRefSchema,
  WebIdentityRefSchema,
]);
export type UserIdentityRef = z.infer<typeof UserIdentityRefSchema>;

export const IdentityRefSchema = z.discriminatedUnion("kind", [
  FeishuIdentityRefSchema,
  ServiceIdentityRefSchema,
  WebIdentityRefSchema,
]);

export type FeishuIdentityRef = z.infer<typeof FeishuIdentityRefSchema>;
export type IdentityRef = z.infer<typeof IdentityRefSchema>;

export function identityKey(ref: IdentityRef): string {
  const identity = IdentityRefSchema.parse(ref);
  return JSON.stringify(
    identity.kind === "feishu"
      ? ["feishu", identity.tenantKey, identity.userId]
      : identity.kind === "web"
        ? ["web", identity.accountId]
        : ["service", identity.serviceId],
  );
}

export function identityFromKey(key: string): IdentityRef {
  const parts: unknown = JSON.parse(key);
  if (!Array.isArray(parts)) throw new Error("无效身份自然键");
  let identity: IdentityRef;
  if (parts[0] === "feishu" && parts.length === 3) {
    identity = IdentityRefSchema.parse({ kind: "feishu", tenantKey: parts[1], userId: parts[2] });
  } else if (parts[0] === "service" && parts.length === 2) {
    identity = IdentityRefSchema.parse({ kind: "service", serviceId: parts[1] });
  } else if (parts[0] === "web" && parts.length === 2) {
    identity = WebIdentityRefSchema.parse({ kind: "web", accountId: parts[1] });
  } else {
    throw new Error("无效身份自然键");
  }
  if (identityKey(identity) !== key) throw new Error("身份自然键必须使用规范编码");
  return identity;
}

export function sameIdentity(
  left: IdentityRef | null | undefined,
  right: IdentityRef | null | undefined,
): boolean {
  if (left == null || right == null) return left === right;
  return identityKey(left) === identityKey(right);
}

/** Internal storage keys only; public API identity fields use IdentityRefSchema. */
export const IdentityKeySchema = z.string().refine((value) => {
  try {
    identityFromKey(value);
    return true;
  } catch {
    return false;
  }
}, "无效身份自然键");

export const PrincipalViewSchema = z.strictObject({
  identity: IdentityRefSchema,
  name: z.string().min(1),
  avatarUrl: z.url().nullable(),
  role: ActorRoleSchema,
});

export const PrincipalSummarySchema = z.strictObject({
  identity: IdentityRefSchema,
  name: z.string().min(1).max(120),
  avatarUrl: z.url().nullable().optional(),
});

export const SessionViewSchema = z.object({
  actor: PrincipalViewSchema,
  csrfToken: z.string().min(32),
  expiresAt: IsoTimestampSchema,
});

export type PrincipalView = z.infer<typeof PrincipalViewSchema>;
export type PrincipalSummary = z.infer<typeof PrincipalSummarySchema>;
export type AuthBootstrap = z.infer<typeof AuthBootstrapSchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;

export const FeishuJsapiConfigSchema = z.object({
  appId: z.string().min(1),
  timestamp: z.number().int().positive(),
  nonceStr: z.string().min(1),
  signature: z.string().regex(/^[a-f0-9]{40}$/),
  jsApiList: z.array(z.string()),
});
export type FeishuJsapiConfig = z.infer<typeof FeishuJsapiConfigSchema>;
