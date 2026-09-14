import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { FeishuJsapiConfigSchema } from "@lark-codex/contracts";
import { AppError } from "../../app-error.js";

interface Options {
  appId: string;
  appSecret: string;
  apiBaseUrl: string;
  origin: string;
  fetcher?: typeof fetch;
}
interface Ticket {
  value: string;
  expiresAt: number;
}
const tokenSchema = z.object({ code: z.literal(0), tenant_access_token: z.string().min(1) });
const ticketSchema = z.object({
  code: z.literal(0),
  data: z.object({ ticket: z.string().min(1), expire_in: z.number().int().positive() }),
});

// Tickets stay server-side and are shared by concurrent requests. Signatures
// are fresh, URL-bound and contain no reusable application credentials.
export class FeishuJsapiService {
  readonly #options: Options;
  #ticket: Ticket | undefined;
  #loading: Promise<Ticket> | undefined;
  constructor(options: Options) {
    this.#options = options;
  }
  async #post(path: string, init: RequestInit) {
    const response = await (this.#options.fetcher ?? fetch)(
      new URL(path, this.#options.apiBaseUrl),
      {
        ...init,
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error("Upstream unavailable");
    return response.json() as Promise<unknown>;
  }
  async #loadTicket(): Promise<Ticket> {
    const token = tokenSchema.parse(
      await this.#post("/open-apis/auth/v3/tenant_access_token/internal", {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: this.#options.appId, app_secret: this.#options.appSecret }),
      }),
    );
    const ticket = ticketSchema.parse(
      await this.#post("/open-apis/jssdk/ticket/get", {
        headers: {
          Authorization: `Bearer ${token.tenant_access_token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: "{}",
      }),
    );
    return { value: ticket.data.ticket, expiresAt: Date.now() + ticket.data.expire_in * 1000 };
  }
  async config(pageUrl: string) {
    const url = z.url().max(8192).parse(pageUrl).split("#")[0]!;
    const parsed = new URL(url);
    if (
      parsed.origin !== new URL(this.#options.origin).origin ||
      parsed.username ||
      parsed.password
    )
      throw new AppError("FORBIDDEN", 403, "只能为当前站点生成飞书鉴权参数");
    try {
      if (!this.#ticket || this.#ticket.expiresAt <= Date.now() + 60_000) {
        this.#loading ??= this.#loadTicket().finally(() => {
          this.#loading = undefined;
        });
        this.#ticket = await this.#loading;
      }
      const timestamp = Date.now(),
        nonceStr = randomUUID();
      const signature = createHash("sha1")
        .update(
          `jsapi_ticket=${this.#ticket.value}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`,
        )
        .digest("hex");
      return FeishuJsapiConfigSchema.parse({
        appId: this.#options.appId,
        timestamp,
        nonceStr,
        signature,
        jsApiList: ["chooseMedia", "readFile"],
      });
    } catch {
      throw new AppError("INTERNAL_ERROR", 503, "飞书相册功能暂时不可用，请重试");
    }
  }
}
