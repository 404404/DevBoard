import { z } from "zod";

import {
  type ExternalIdentity,
  type IdentityProvider,
  IdentityProviderError,
} from "../identity-provider.js";

const AppAccessTokenResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  app_access_token: z.string().min(1).optional(),
  expire: z.number().int().positive().optional(),
});

const UserAccessTokenResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z
    .object({
      access_token: z.string().min(1),
    })
    .optional(),
});

const UserInfoResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z
    .object({
      tenant_key: z.string().min(1),
      user_id: z.string().min(1).optional(),
      name: z.string().min(1),
      avatar_url: z.url().optional(),
    })
    .optional(),
});

interface FeishuIdentityAdapterOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly apiBaseUrl: string;
  readonly fetcher?: typeof fetch;
}

interface CachedAppToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause: unknown) {
    throw new IdentityProviderError("飞书认证服务返回了无法解析的响应", { cause });
  }
}

export class FeishuIdentityAdapter implements IdentityProvider {
  readonly kind = "feishu";
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #apiBaseUrl: string;
  readonly #fetcher: typeof fetch;
  #cachedAppToken: CachedAppToken | undefined;

  constructor(options: FeishuIdentityAdapterOptions) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#apiBaseUrl = options.apiBaseUrl;
    this.#fetcher = options.fetcher ?? globalThis.fetch;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.#fetcher(new URL(path, this.#apiBaseUrl), {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new IdentityProviderError(`飞书认证服务 HTTP ${response.status}`);
    }
    return response;
  }

  async #getAppAccessToken(): Promise<string> {
    if (this.#cachedAppToken && this.#cachedAppToken.expiresAtMs > Date.now() + 60_000) {
      return this.#cachedAppToken.value;
    }

    const response = await this.#request("/open-apis/auth/v3/app_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.#appId, app_secret: this.#appSecret }),
    });
    const payload = AppAccessTokenResponseSchema.safeParse(await readJson(response));

    if (!payload.success || payload.data.code !== 0 || !payload.data.app_access_token) {
      throw new IdentityProviderError("飞书应用访问凭证获取失败");
    }

    const expiresInSeconds = payload.data.expire ?? 7_200;
    this.#cachedAppToken = {
      value: payload.data.app_access_token,
      expiresAtMs: Date.now() + expiresInSeconds * 1_000,
    };
    return payload.data.app_access_token;
  }

  async exchangeCode(code: string): Promise<ExternalIdentity> {
    const appAccessToken = await this.#getAppAccessToken();

    // requestAuthCode 的端内免登流程目前仍使用飞书官方保留的 authen/v1 合同；
    // 该差异被限制在此适配器内，部署验收时必须对真实企业应用做协议冒烟。
    const tokenResponse = await this.#request("/open-apis/authen/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appAccessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ grant_type: "authorization_code", code }),
    });
    const tokenPayload = UserAccessTokenResponseSchema.safeParse(await readJson(tokenResponse));

    if (!tokenPayload.success || tokenPayload.data.code !== 0 || !tokenPayload.data.data) {
      throw new IdentityProviderError("飞书登录授权码交换失败");
    }

    const userResponse = await this.#request("/open-apis/authen/v1/user_info", {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenPayload.data.data.access_token}` },
    });
    const userPayload = UserInfoResponseSchema.safeParse(await readJson(userResponse));

    if (!userPayload.success || userPayload.data.code !== 0 || !userPayload.data.data) {
      throw new IdentityProviderError("飞书用户信息读取失败");
    }

    if (!userPayload.data.data.user_id) {
      throw new IdentityProviderError(
        "飞书未返回 user_id，请为应用开通获取用户 user ID 权限并重新登录",
      );
    }

    return {
      identity: {
        kind: "feishu",
        tenantKey: userPayload.data.data.tenant_key,
        userId: userPayload.data.data.user_id,
      },
      name: userPayload.data.data.name,
      avatarUrl: userPayload.data.data.avatar_url ?? null,
    };
  }
}
