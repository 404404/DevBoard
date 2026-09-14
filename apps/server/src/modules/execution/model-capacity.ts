export const MODEL_CAPACITY_NOTICE =
  "所选模型当前容量不足，对话已停止，任务仍保持执行中。请点击“取消执行”暂停后再重试。";

export function isModelAtCapacity(message: unknown): boolean {
  return typeof message === "string" && /Selected model is at capacity\./i.test(message);
}
