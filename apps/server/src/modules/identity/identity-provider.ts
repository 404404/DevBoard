import type { IdentityRef } from "@codexboard/contracts";

export interface ExternalIdentity {
  readonly identity: IdentityRef;
  readonly name: string;
  readonly avatarUrl: string | null;
}

export interface IdentityProvider {
  readonly kind: "feishu" | "development" | "web";
  exchangeCode(code: string): Promise<ExternalIdentity>;
}

export class IdentityProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityProviderError";
  }
}
