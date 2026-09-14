import type { ExternalIdentity, IdentityProvider } from "../identity-provider.js";

export const DEVELOPMENT_IDENTITY: ExternalIdentity = {
  identity: { kind: "service", serviceId: "local-admin" },
  name: "本地开发管理员",
  avatarUrl: null,
};

export class DevelopmentIdentityAdapter implements IdentityProvider {
  readonly kind = "development";
  async exchangeCode(): Promise<ExternalIdentity> {
    return DEVELOPMENT_IDENTITY;
  }
}
