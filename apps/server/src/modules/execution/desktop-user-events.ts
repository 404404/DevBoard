import { z } from "zod";
import type { CodexExecutionEvent } from "./codex-executor.js";

/** Read-only projection of Desktop user items; never creates an executable board comment. */
export function desktopUserEvent(raw: unknown, threadId: string): CodexExecutionEvent | null {
  const parsed = z
    .object({
      type: z.enum(["userMessage", "steeringUserMessage"]),
      id: z.string().min(1),
      clientId: z.string().nullish(),
      clientUserMessageId: z.string().nullish(),
      serverUserMessageId: z.string().nullish(),
      status: z.string().optional(),
      content: z.array(z.record(z.string(), z.unknown())).optional(),
      input: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .safeParse(raw);
  if (!parsed.success || parsed.data.status === "rejected") return null;
  const item = parsed.data;
  const clientId = item.clientUserMessageId ?? item.clientId;
  let imageIndex = 0;
  const body = (item.content ?? item.input ?? [])
    .flatMap((entry) => {
      if (entry.type === "text" && typeof entry.text === "string") return [entry.text];
      if (entry.type === "image" || entry.type === "localImage") {
        const index = imageIndex++;
        return [
          `![图片 ${index + 1}](/api/v1/remote/threads/${encodeURIComponent(threadId)}/images/${encodeURIComponent(item.serverUserMessageId ?? item.id)}/${index})`,
        ];
      }
      return [];
    })
    .join("\n")
    .trim();
  if (!body) return null;
  return {
    cursor: `desktop-user:${clientId ?? item.serverUserMessageId ?? item.id}`,
    kind: "codex.user_message",
    summary: body.slice(0, 2000),
    safePayload: {
      text: body,
      messageIds: [
        ...new Set(
          [item.id, item.serverUserMessageId, clientId].filter((id): id is string => Boolean(id)),
        ),
      ],
      itemType: item.type,
      ...(clientId ? { clientId } : {}),
    },
  };
}
