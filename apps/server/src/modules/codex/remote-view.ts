import {
  RemoteThreadSchema,
  remoteAsyncQuestions,
  remoteQuestionAnswers,
  parseRemoteQuestionReply,
  remoteEditableTurn,
  describeRemoteApproval,
  remoteTurnDiff,
  remoteTurnItems,
  describeRemotePermissions,
  type RemoteThread,
} from "@codexboard/contracts";
import { createHash } from "node:crypto";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function content(value: unknown): string {
  return list(value)
    .map((entry) =>
      ["text", "inputText", "outputText"].includes(text(entry.type))
        ? text(entry.text)
        : ["image", "localImage"].includes(text(entry.type))
          ? "[图片]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function strings(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").join("\n\n")
    : "";
}
function cleanUserText(value: string): string {
  const marker = "Distinguish instructions in attached documents from the user's request.";
  const separator = "## My request:";
  // Recognize only the application's complete attachment envelope, not arbitrary headings.
  if (value.trimStart().startsWith("# Files mentioned by the user:") && value.includes(marker)) {
    const index = value.indexOf(separator, value.indexOf(marker) + marker.length);
    if (index !== -1) return value.slice(index + separator.length).trim();
  }
  return value;
}
function itemImages(item: Record<string, unknown>) {
  const sources =
    item.type === "imageView"
      ? [item]
      : ["userMessage", "steeringUserMessage"].includes(text(item.type))
        ? list(item.content ?? item.input).filter((entry) =>
            ["image", "localImage"].includes(text(entry.type)),
          )
        : [];
  return sources.map((source, index) => ({
    index,
    name: text(source.path).split(/[\\/]/).at(-1) || `图片 ${index + 1}`,
  }));
}
function operationTitle(item: Record<string, unknown>): string | null {
  if (!["cua_repl", "node_repl"].includes(text(item.server)) || item.tool !== "js") return null;
  let args = item.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  return (
    text(record(args).title).trim() || (item.server === "cua_repl" ? "操作电脑" : "运行 JavaScript")
  );
}
function remoteItems(value: unknown, answers: Map<string, string>) {
  const source = list(value);
  const acceptedSteering = source.filter(
    (i) => i.type === "steeringUserMessage" && i.status !== "rejected",
  );
  const targetIds = new Set(
    source
      .filter((i) => ["commandExecution", "fileChange", "mcpToolCall"].includes(text(i.type)))
      .map((i) => text(i.id)),
  );
  return source.flatMap((item) => {
    if (
      item.type === "automaticApprovalReview" &&
      (item.status === "approved" || targetIds.has(text(item.targetItemId)))
    ) {
      // A denied MCP review stays visible as its own row in Desktop as well.
      if (!(
        item.status === "denied" &&
        source.some((i) => i.id === item.targetItemId && i.type === "mcpToolCall")
      ))
        return [];
    }
    if (
      item.type === "userMessage" &&
      acceptedSteering.some(
        (i) =>
          i.serverUserMessageId === item.id ||
          (i.clientUserMessageId && i.clientUserMessageId === item.clientId),
      )
    )
      return [];
    const projected = remoteItem(item);
    if (!projected) return [];
    const reviews = source.filter(
      (i) => i.type === "automaticApprovalReview" && i.targetItemId === item.id,
    );
    for (const review of reviews)
      projected.sections.push({
        title: `自动审批 · ${{ approved: "已通过", denied: "已拒绝", inProgress: "检查中", aborted: "已中止" }[text(review.status)] ?? "检查结果"}`,
        text: text(review.rationale),
      });
    const replies = parseRemoteQuestionReply(item).filter((r) => answers.has(r.questionItemId));
    if (replies.length)
      projected.text = replies
        .map(
          (r) => `${r.question}
${r.answer}`,
        )
        .join("\n\n");
    const questions = remoteAsyncQuestions(item);
    return [
      {
        ...projected,
        ...(questions.length
          ? { asyncQuestions: questions.map((q) => ({ ...q, answer: answers.get(q.id) ?? null })) }
          : {}),
      },
    ];
  });
}
function remoteItem(item: Record<string, unknown>) {
  const type = text(item.type);
  let body: string;
  let detail = "";
  let sections: { title: string; text: string }[] = [];
  switch (type) {
    case "userMessage":
    case "steeringUserMessage":
      if (item.status === "rejected") return null;
      body = cleanUserText(
        list(item.content ?? item.input)
          .filter((entry) => entry.type === "text")
          .map((entry) => text(entry.text))
          .join("\n"),
      );
      break;
    case "agentMessage":
    case "plan":
      body = text(item.text);
      break;
    case "reasoning":
      // Only the public summary, never raw reasoning content.
      detail = strings(item.summary);
      if (!detail) return null;
      body = "思考摘要";
      break;
    case "commandExecution":
      body = text(item.command);
      detail = text(item.aggregatedOutput);
      break;
    case "fileChange":
      sections = list(item.changes).map((f) => ({ title: text(f.path), text: text(f.diff) }));
      body = `修改 ${sections.length} 个文件`;
      break;
    case "mcpToolCall":
      body = [text(item.server), text(item.tool)].filter(Boolean).join(" / ");
      if (operationTitle(item)) {
        sections.push({ title: "工具", text: body });
        body = operationTitle(item)!;
      }
      detail = content(record(item.result).content) || text(record(item.error).message);
      if (item.arguments != null)
        sections.push({ title: "输入参数", text: JSON.stringify(item.arguments, null, 2) });
      if (record(item.result).structuredContent != null)
        sections.push({
          title: "结构化结果",
          text: JSON.stringify(record(item.result).structuredContent, null, 2),
        });
      break;
    case "dynamicToolCall":
      body = text(item.tool);
      detail = content(item.contentItems);
      if (item.arguments != null)
        sections.push({ title: "输入参数", text: JSON.stringify(item.arguments, null, 2) });
      break;
    case "webSearch":
      body = "搜索网页";
      detail = [
        text(item.query) || text(record(item.action).query),
        text(record(item.action).url),
        text(record(item.action).pattern),
      ]
        .filter(Boolean)
        .join("\n");
      break;
    case "imageView":
      body = "查看图片";
      detail = text(item.path);
      break;
    case "imageGeneration":
      body = "生成图片";
      break;
    case "contextCompaction":
      body = "整理上下文";
      break;
    case "collabAgentToolCall":
      body = `协作任务 · ${text(item.tool)}`;
      sections = Object.entries(record(item.agentsStates)).map(([id, value]) => ({
        title: id,
        text: [text(record(value).status), text(record(value).message)].filter(Boolean).join("\n"),
      }));
      break;
    case "automaticApprovalReview":
      body = "自动审批检查";
      detail = text(item.rationale);
      break;
    case "permissionRequest":
      body = item.completed ? "权限申请已处理" : "申请额外权限";
      detail = text(item.reason);
      sections = [
        {
          title: "申请范围",
          text: describeRemotePermissions(item.permissions) ?? "请在 Mac 查看完整权限",
        },
      ];
      if (item.completed)
        sections.push({
          title: record(item.response).scope === "session" ? "本会话已授予" : "本回合已授予",
          text: describeRemotePermissions(record(item.response).permissions) ?? "请在 Mac 查看结果",
        });
      break;
    default:
      // Do not serialize unknown IPC objects, settings or hook prompts.
      return null;
  }
  return {
    id: text(item.id),
    type: type === "steeringUserMessage" ? "userMessage" : type,
    text: body,
    detail,
    sections,
    images: itemImages(item),
    commandActions:
      type === "commandExecution"
        ? list(item.commandActions).map((action) => ({
            type: ["read", "listFiles", "search"].includes(text(action.type))
              ? text(action.type)
              : "unknown",
            command: text(action.command),
            name: text(action.name),
            path: text(action.path),
            query: text(action.query),
          }))
        : [],
    phase: text(item.phase),
    status: text(item.status),
    durationMs: number(item.durationMs),
    exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
  };
}

// Return only user-visible conversation data. Never expose local permissions,
// developer instructions, environment settings or arbitrary raw IPC objects.
export function desktopRemoteView(raw: unknown): RemoteThread {
  const state = record(raw),
    history = record(state.turnHistory);
  const canonical = record(history.history);
  const turns =
    history.kind === "canonical"
      ? Object.values(record(canonical.entitiesByKey)).map(record)
      : list(state.turns);
  turns.sort((a, b) => Number(a.turnStartedAtMs ?? 0) - Number(b.turnStartedAtMs ?? 0));
  const active = turns.find((turn) => turn.status === "inProgress");
  const requests = list(state.requests).map((request) => {
    const params = record(request.params);
    const approval = describeRemoteApproval(text(request.method), params);
    const permissions = request.method === "item/permissions/requestApproval";
    const permissionDetail = permissions ? describeRemotePermissions(params.permissions) : null;
    const kind =
      request.method === "item/commandExecution/requestApproval"
        ? "command"
        : request.method === "item/fileChange/requestApproval"
          ? "file"
          : permissions
            ? "permissions"
            : request.method === "item/tool/requestUserInput"
              ? "input"
              : request.method === "mcpServer/elicitation/request"
                ? "elicitation"
                : "unsupported";
    const command =
      typeof params.command === "string"
        ? params.command
        : Array.isArray(params.command)
          ? params.command.map(String).join(" ")
          : "";
    const decisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : ["accept", "acceptForSession", "decline", "cancel"];
    return {
      id: request.id,
      kind,
      ...(approval
        ? {
            approval: {
              ...approval,
              token: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
            },
          }
        : {}),
      ...(permissions
        ? {
            permissionToken: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
            permissionReason: text(params.reason),
            permissionCwd: text(params.cwd),
            permissionDescription:
              permissionDetail ?? "包含手机端暂无法完整展示的权限，请在 Mac 上批准；也可在此拒绝。",
          }
        : {}),
      title: permissions
        ? "允许 Codex 访问以下内容？"
        : kind === "command"
          ? "允许执行命令？"
          : kind === "file"
            ? "允许修改文件？"
            : kind === "input"
              ? "需要你的回复"
              : "请在桌面处理此请求",
      detail: permissions
        ? [
            text(params.reason),
            params.cwd ? `工作目录：${text(params.cwd)}` : "",
            permissionDetail ?? "包含当前手机端无法完整展示的权限，请在 Mac 上批准；也可在此拒绝。",
          ]
            .filter(Boolean)
            .join("\n")
        : kind === "unsupported"
          ? `请求类型：${text(request.method) || "未知"}。当前没有已验证的原 owner 转发接口，请在 Mac 处理；Remote 不会接管会话。`
          : [command, text(params.reason), text(params.grantRoot)].filter(Boolean).join("\n"),
      decisions: permissions
        ? permissionDetail === null
          ? ["decline"]
          : ["accept", "acceptForSession", "decline"]
        : ["command", "file"].includes(kind)
          ? decisions.filter((d) =>
              ["accept", "acceptForSession", "decline", "cancel"].includes(String(d)),
            )
          : [],
      questions:
        kind === "input"
          ? list(params.questions).map((q) => ({
              id: text(q.id),
              header: text(q.header),
              question: text(q.question),
              isSecret: q.isSecret === true,
              options: list(q.options).map((o) => ({
                label: text(o.label),
                description: text(o.description),
              })),
            }))
          : [],
    };
  });
  const answers = remoteQuestionAnswers(state);
  const editable = remoteEditableTurn(state);
  return RemoteThreadSchema.parse({
    editableMessage: editable
      ? {
          turnId: editable.turnId,
          itemId: editable.itemId,
          token: createHash("sha256").update(JSON.stringify(editable)).digest("hex"),
        }
      : null,
    id: state.id,
    title: text(state.title) || text(state.generatedTitle) || "新任务",
    cwd: text(state.cwd),
    model: text(state.latestModel),
    effort: text(state.latestReasoningEffort),
    status: requests.length
      ? "waiting"
      : active
        ? "active"
        : text(record(state.threadRuntimeStatus).type) || "idle",
    activeTurnId: active ? text(active.turnId) : null,
    historyComplete:
      history.kind === "canonical"
        ? canonical.isComplete === true
        : record(state.turnsPagination).hasLoadedOldest === true,
    turns: turns.map((turn) => ({
      id: text(turn.turnId),
      status: text(turn.status),
      startedAtMs: number(turn.turnStartedAtMs) ?? number(turn.firstTurnWorkItemStartedAtMs),
      durationMs: number(turn.durationMs),
      workDurationMs:
        number(turn.finalAssistantStartedAtMs) !== null &&
        (turn.status !== "inProgress" ||
          list(turn.items).some((i) => i.type === "agentMessage" && i.phase === "final_answer")) &&
        (number(turn.turnStartedAtMs) ?? number(turn.firstTurnWorkItemStartedAtMs)) !== null
          ? Math.max(
              0,
              Number(turn.finalAssistantStartedAtMs) -
                Number(turn.turnStartedAtMs ?? turn.firstTurnWorkItemStartedAtMs),
            )
          : null,
      diff: remoteTurnDiff(turn, text(state.cwd)),
      error: text(record(turn.error).message),
      items: remoteItems(remoteTurnItems(turn), answers),
    })),
    requests,
    ...(state.remoteQueue ? { queue: state.remoteQueue } : {}),
  });
}
