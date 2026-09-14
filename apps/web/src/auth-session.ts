import type { SessionView } from "@lark-codex/contracts";
import { ApiError, loginDevelopment, loginFeishu, readAuthBootstrap, readSession } from "./api";
import { requestFeishuAuthCode } from "./feishu";

export async function restoreOrCreateSession(): Promise<SessionView> {
  const bootstrap = await readAuthBootstrap();
  // A cached local session cannot reveal a changed Feishu avatar. Refresh identity
  // once on application entry; task/project queries continue using the shared actor.
  if (bootstrap.authMode === "feishu") {
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
