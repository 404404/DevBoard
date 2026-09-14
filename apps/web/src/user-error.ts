import { ApiError } from "./api";

/** Only controlled UI copy may cross the error-to-message boundary. */
export function userErrorMessage(error: unknown, fallback = "操作失败，请稍后重试。"): string {
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
  )
    return "网络连接中断，请检查网络后重试。";
  if (error instanceof ApiError) {
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
