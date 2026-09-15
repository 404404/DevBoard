import type { SessionView } from "@lark-codex/contracts";
import { ApiError, loginDevelopment, loginFeishu, readAuthBootstrap, readSession } from "./api";
import { requestFeishuAuthCode } from "./feishu";

export class WebLoginRequired extends Error {
  constructor(readonly enabled: boolean) {
    super("请登录后访问任务看板");
  }
}

export async function restoreOrCreateSession(): Promise<SessionView> {
  const bootstrap = await readAuthBootstrap();
  // A cached local session cannot reveal a changed Feishu avatar. Refresh identity
  // once on application entry; task/project queries continue using the shared actor.
  if (bootstrap.authMode === "web") {
    try {
      return await readSession();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      throw new WebLoginRequired(bootstrap.webLoginEnabled);
    }
  }
  if (bootstrap.authMode === "feishu") {
    if (!/Lark|Feishu/i.test(navigator.userAgent)) {
      try {
        return await readSession();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        throw new WebLoginRequired(bootstrap.webLoginEnabled);
      }
    }
    const code = await requestFeishuAuthCode(bootstrap.feishuAppId);
    return loginFeishu(code);
  }
  try {
    return await readSession();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    return loginDevelopment();
  }
}
