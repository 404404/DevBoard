import { remoteTurnItems } from "./remote-turn-items.js";

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function remoteConversationTurns(state: unknown): Record<string, unknown>[] {
  const s = record(state);
  const history = record(s.turnHistory);
  const turns =
    history.kind === "canonical"
      ? Object.values(record(record(history.history).entitiesByKey))
      : (s.turns ?? []);
  return (Array.isArray(turns) ? turns : [])
    .map(record)
    .sort((a, b) => Number(a.turnStartedAtMs ?? 0) - Number(b.turnStartedAtMs ?? 0));
}
export function remoteAsyncQuestions(
  item: unknown,
): { id: string; title: string; options: string[] }[] {
  const i = record(item);
  if (i.type !== "agentMessage" || i.delivery !== "async" || typeof i.id !== "string") return [];
  if (!Array.isArray(i.questions) || !i.questions.length)
    return typeof i.text === "string" && i.text.trim()
      ? [{ id: i.id, title: i.text, options: [] }]
      : [];
  return i.questions.flatMap((value: unknown, index: number) => {
    const q = record(value);
    if (typeof q.title !== "string" || !q.title.trim()) return [];
    return [
      {
        id: JSON.stringify(["request_user_input_async", i.id, index]),
        title: q.title,
        options: Array.isArray(q.options)
          ? q.options.filter((o: unknown): o is string => typeof o === "string")
          : [],
      },
    ];
  });
}
export function parseRemoteQuestionReply(
  item: unknown,
): { questionItemId: string; question: string; answer: string }[] {
  const i = record(item);
  if (i.type !== "userMessage" && !(i.type === "steeringUserMessage" && i.status === "accepted"))
    return [];
  const content = i.content ?? i.input;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") return [];
  const text = String(content[0].text ?? "").trim();
  const start = "<send_user_message_question_reply>",
    end = "</send_user_message_question_reply>";
  if (!text.startsWith(start) || !text.endsWith(end)) return [];
  try {
    const data = JSON.parse(text.slice(start.length, -end.length));
    const entries = Array.isArray(data) ? data : [data];
    return entries.filter(
      (e) =>
        e &&
        typeof e.questionItemId === "string" &&
        typeof e.question === "string" &&
        typeof e.answer === "string",
    );
  } catch {
    return [];
  }
}
export function remoteQuestionAnswers(state: unknown): Map<string, string> {
  const items = remoteConversationTurns(state).flatMap(remoteTurnItems);
  const ids = new Set(items.flatMap(remoteAsyncQuestions).map((q) => q.id));
  const answers = new Map<string, string>();
  for (const item of items)
    for (const reply of parseRemoteQuestionReply(item))
      if (ids.has(reply.questionItemId)) answers.set(reply.questionItemId, reply.answer);
  return answers;
}
export function remoteEditableTurn(
  state: unknown,
): { turnId: string; itemId: string; input: unknown[] } | null {
  const turns = remoteConversationTurns(state);
  if (
    record(record(state).threadRuntimeStatus).type === "active" ||
    turns.some((t) => t.status === "inProgress")
  )
    return null;
  const turn = turns
    .filter(
      (t) => Array.isArray(record(t.params).input) && (record(t.params).input as unknown[]).length,
    )
    .at(-1);
  const input = turn ? (record(turn.params).input as unknown[]) : [];
  if (
    !turn ||
    typeof turn.turnId !== "string" ||
    !input.some((value) => {
      const i = record(value);
      return i.type === "text" && typeof i.text === "string" && i.text.trim();
    })
  )
    return null;
  const item = remoteTurnItems(turn).find((i) => i.type === "userMessage");
  if (!item || typeof item.id !== "string" || parseRemoteQuestionReply(item).length) return null;
  return { turnId: turn.turnId, itemId: item.id, input };
}
