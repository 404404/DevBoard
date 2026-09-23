import { ApiError } from "./api";

/** Only controlled UI copy may cross the error-to-message boundary. */
export function userErrorMessage(error: unknown, fallback = "操作失败，请稍后重试。"): string {
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
  )
    return "网络连接中断，请检查网络后重试。";
  if (error instanceof ApiError) {
    switch (error.code) {
      case "SSH_AGENT_UNAVAILABLE":
        return "SSH Agent 不可用，请检查容器中的 SSH_AUTH_SOCK 挂载或选择 Identity File。";
      case "SSH_IDENTITY_NOT_FOUND":
        return "所选 SSH Identity 不存在，请刷新目录并重新选择。";
      case "SSH_IDENTITY_INVALID":
        return "SSH Identity 引用或文件类型无效，请从 Identity Catalog 重新选择。";
      case "SSH_IDENTITY_PERMISSIONS":
        return "SSH Identity 权限不安全或 DevBoard 无权读取；请将文件设为 owner-only（通常 chmod 600）。";
      case "SSH_KEY_PASSPHRASE_REQUIRED":
        return "该 SSH 私钥需要 passphrase；请先通过 SSH Agent 加载，再选择 SSH Agent 认证。";
      case "HOST_KEY_UNTRUSTED":
        return "SSH Host Key 尚未信任；请核对 SHA256 指纹后明确确认。";
      case "HOST_KEY_CHANGED":
        return "SSH Host Key 已改变，连接已被阻止；请先确认目标主机密钥变更。";
      case "SSH_AUTH_FAILED":
        return "SSH 认证失败，请检查远端用户名、Identity 或 Agent。";
    }
    switch (error.status) {
      case 401:
        return "登录已失效，请重新登录。";
      case 403:
        return "当前操作未获允许，请刷新页面后重试。";
      case 404:
        return "内容已不存在，请刷新后重试。";
      case 409:
        return "数据已更新，请刷新后重试。";
      case 429:
        return "操作频繁，请稍后重试。";
      case 502:
      case 503:
      case 504:
        return "服务暂时无法连接，请稍后重试。";
    }
  }
  return fallback;
}
