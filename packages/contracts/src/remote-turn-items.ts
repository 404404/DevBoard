function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function inputKey(value: unknown): string {
  return JSON.stringify(records(value).map((item) => [item.type, item.text, item.path, item.url]));
}

// Desktop renders the turn's confirmed opening input before its asynchronously
// hydrated items. Share that projection with image lookup so previews also work.
export function remoteTurnItems(value: unknown): Record<string, unknown>[] {
  const turn = record(value);
  const items = records(turn.items);
  const params = record(turn.params);
  const input = records(params.input);
  if (!input.length || typeof turn.turnId !== "string") return items;
  const openingId = record(turn.itemsPagination).openingUserMessageId;
  if (
    openingId &&
    items.some(
      (item) => item.type === "steeringUserMessage" && item.serverUserMessageId === openingId,
    )
  )
    return items;
  const opening = items.find((item) => {
    if (item.type !== "userMessage") return false;
    if (openingId) return item.id === openingId;
    if (item.clientId && params.clientUserMessageId)
      return item.clientId === params.clientUserMessageId;
    return inputKey(item.content) === inputKey(input);
  });
  return [
    opening ?? {
      type: "userMessage",
      id: `remote-input:${turn.turnId}`,
      clientId: params.clientUserMessageId,
      content: input,
    },
    ...items.filter((item) => item !== opening),
  ];
}
