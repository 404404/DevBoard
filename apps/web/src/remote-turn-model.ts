import type { RemoteThread } from "@codexboard/contracts";
export type RemoteTurn = RemoteThread["turns"][number];
type Turn = RemoteTurn;
export type RemoteItem = Turn["items"][number];
export type RemoteCommandAction = NonNullable<RemoteItem["commandActions"]>[number];
export function splitRemoteTurn(turn: Turn) {
  const explicitFinal = turn.items.filter(
    (i) => i.type === "agentMessage" && i.phase === "final_answer" && !i.asyncQuestions?.length,
  );
  // Older Desktop history has no phase. Only its last unclassified message
  // in a successfully completed turn can serve as the final answer.
  const fallback =
    turn.status === "completed" && explicitFinal.length === 0
      ? turn.items
          .filter((i) => i.type === "agentMessage" && !i.phase && !i.asyncQuestions?.length)
          .at(-1)
      : undefined;
  const answers = explicitFinal.length ? explicitFinal : fallback ? [fallback] : [];
  // Keep pending questions accessible; answered questions return to their original
  // position in the activity stream instead of being treated as final answers.
  const final = turn.items.filter(
    (i) => answers.includes(i) || i.asyncQuestions?.some((q) => q.answer === null),
  );
  const firstActivity = turn.items.findIndex((i) => i.type !== "userMessage");
  const leading = firstActivity < 0 ? turn.items.length : firstActivity;
  return {
    users: turn.items.slice(0, leading),
    // Mid-turn user input belongs at its original position in the activity stream.
    progress: turn.items.slice(leading).filter((i) => !final.includes(i)),
    final,
  };
}
export function remoteDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return [hours ? `${hours} 小时` : "", minutes ? `${minutes} 分钟` : "", `${seconds % 60} 秒`]
    .filter(Boolean)
    .join(" ");
}

export function groupRemoteProgress(items: Turn["items"]) {
  const groups: { kind: "commands" | "item"; items: Turn["items"] }[] = [];
  for (const item of items) {
    // Desktop does not render reasoning summaries as standalone activity rows.
    // Skip before grouping so they cannot split adjacent command groups.
    if (item.type === "reasoning") continue;
    if (item.type === "automaticApprovalReview" && item.status === "approved") continue;
    const previous = groups.at(-1);
    if (
      ["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch"].includes(
        item.type,
      )
    ) {
      if (previous?.kind === "commands") previous.items.push(item);
      else groups.push({ kind: "commands", items: [item] });
    } else groups.push({ kind: "item", items: [item] });
  }
  return groups;
}

export function remoteCommandSource(command: string) {
  // Display only; this string is never evaluated or sent back to the shell.
  const wrapped = command.match(/^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+(["'])([\s\S]*)\1$/);
  return wrapped?.[2] ?? command;
}
export function remoteCommandTitle(command: string) {
  return remoteCommandSource(command).replace(/\s+/g, " ").trim();
}
export interface RemoteCommandRow {
  item: RemoteItem;
  action: RemoteCommandAction | undefined;
  key: string;
}
export function remoteCommandRows(items: RemoteItem[]) {
  return items.flatMap<RemoteCommandRow>((item) => {
    const actions = item.commandActions ?? [];
    // Only Desktop's parsed read/search/list actions can become separate rows.
    return actions.length && actions.every((a) => a.type !== "unknown")
      ? actions.map((action, index) => ({ item, action, key: `${item.id}:${index}` }))
      : [{ item, action: undefined, key: item.id }];
  });
}
export function remoteCommandGroupLabel(rows: ReturnType<typeof remoteCommandRows>) {
  const count = (kind: string) => rows.filter((row) => row.action?.type === kind).length;
  const reads = count("read"),
    searches = count("search"),
    lists = count("listFiles");
  const commands = rows.filter((row) => !row.action && row.item.type === "commandExecution").length;
  const tools = rows.filter((row) =>
    ["mcpToolCall", "dynamicToolCall"].includes(row.item.type),
  ).length;
  const edits = rows.filter((row) => row.item.type === "fileChange").length;
  const webSearches = rows.filter((row) => row.item.type === "webSearch").length;
  if (!reads && !searches && !lists && !tools && !edits && !webSearches)
    return rows.some((row) => row.item.status === "inProgress") ? "正在运行命令" : "运行了命令";
  const parts = [
    reads ? `读取 ${reads} 个文件` : "",
    searches ? `搜索 ${searches} 次` : "",
    lists ? `列出 ${lists} 个目录` : "",
    commands ? `运行 ${commands} 条命令` : "",
    tools ? `调用 ${tools} 次工具` : "",
    edits ? `修改文件 ${edits} 次` : "",
    webSearches ? `搜索网页 ${webSearches} 次` : "",
  ].filter(Boolean);
  return `${rows.some((row) => row.item.status === "inProgress") ? "正在" : "已"}${parts.join("并")}`;
}

export function remoteCommandLabel(item: RemoteItem, action?: RemoteCommandAction) {
  const active = item.status === "inProgress";
  if (action?.type === "read")
    return `${active ? "正在读取" : "已读取"} ${action.name || action.path.split(/[\\/]/).at(-1)}`;
  if (action?.type === "listFiles")
    return `${active ? "正在列出" : "已列出"} ${action.path || "目录"}`;
  if (action?.type === "search")
    return `${active ? "正在搜索" : "已搜索"} ${action.query || action.path}`;
  return `${active ? "正在运行" : "已运行"} ${remoteCommandTitle(item.text)}`;
}

// Desktop chooses the newest unfinished operation within the last visible group.
// Completed, failed and interrupted items never keep a running label alive.
export function remoteActivityHeader(items: RemoteItem[]): { label: string; kind: string | null } {
  const item = items.findLast((item) => item.status === "inProgress");
  if (!item) return { label: "正在思考", kind: null };
  switch (item.type) {
    case "commandExecution": {
      const rows = remoteCommandRows([item]);
      return {
        label:
          rows.length > 1
            ? remoteCommandGroupLabel(rows)
            : remoteCommandLabel(item, rows[0]?.action),
        kind: rows[0]?.action?.type ?? "command",
      };
    }
    case "fileChange":
      return { label: "正在编辑文件", kind: "fileChange" };
    case "webSearch":
      return {
        label: `正在搜索网页${item.detail ? ` ${item.detail.split("\n")[0]}` : ""}`,
        kind: "search",
      };
    case "mcpToolCall":
    case "dynamicToolCall":
      return { label: item.text.split("\n")[0] || "正在调用工具", kind: "command" };
    default:
      return { label: "正在思考", kind: null };
  }
}
