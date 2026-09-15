import { expect, it } from "vitest";
import type { RemoteThread } from "@codexboard/contracts";
import {
  remoteDuration,
  splitRemoteTurn,
  groupRemoteProgress,
  remoteCommandTitle,
  remoteCommandRows,
  remoteCommandGroupLabel,
} from "./remote-turn-model";
const turn: RemoteThread["turns"][number] = {
  id: "turn",
  status: "completed",
  diff: "",
  error: "",
  items: [
    { id: "u", type: "userMessage", text: "user", detail: "" },
    { id: "p", type: "agentMessage", phase: "commentary", text: "progress", detail: "" },
    { id: "t", type: "commandExecution", text: "test", detail: "passed" },
    { id: "f", type: "agentMessage", phase: "final_answer", text: "done", detail: "" },
  ],
};
it("separates explicit final answers from progress without losing tool output", () => {
  const result = splitRemoteTurn(turn);
  expect(result.users.map((i) => i.id)).toEqual(["u"]);
  expect(result.progress.map((i) => i.id)).toEqual(["p", "t"]);
  expect(result.final.map((i) => i.id)).toEqual(["f"]);
});
it("does not promote commentary or interrupted streaming text to a final answer", () => {
  expect(splitRemoteTurn({ ...turn, items: turn.items.slice(0, 3) }).final).toEqual([]);
  expect(
    splitRemoteTurn({
      ...turn,
      status: "interrupted",
      items: [{ id: "a", type: "agentMessage", text: "partial", detail: "" }],
    }).final,
  ).toEqual([]);
});
it("supports legacy history using only its last unclassified completed message", () => {
  const items = [1, 2].map((i) => ({
    id: String(i),
    type: "agentMessage",
    text: String(i),
    detail: "",
  }));
  expect(splitRemoteTurn({ ...turn, items }).final.map((i) => i.id)).toEqual(["2"]);
  expect(splitRemoteTurn({ ...turn, status: "inProgress", items }).final).toEqual([]);
});
it("formats actual duration including zero, minute and hour boundaries", () => {
  expect(remoteDuration(0)).toBe("0 秒");
  expect(remoteDuration(87940)).toBe("1 分钟 27 秒");
  expect(remoteDuration(3601000)).toBe("1 小时 1 秒");
});

it("groups consecutive commands and keeps commentary boundaries", () => {
  const command = { id: "c", type: "commandExecution", text: "test", detail: "" };
  const note = { id: "n", type: "agentMessage", text: "progress", detail: "" };
  const groups = groupRemoteProgress([
    command,
    { ...command, id: "c2" },
    note,
    { ...command, id: "c3" },
  ]);
  expect(groups.map((g) => [g.kind, g.items.length])).toEqual([
    ["commands", 2],
    ["item", 1],
    ["commands", 1],
  ]);
});
it("shortens shell wrappers for labels without evaluating or losing raw commands", () => {
  expect(remoteCommandTitle("/bin/zsh -lc 'npm test\n && npm build'")).toBe(
    "npm test && npm build",
  );
  expect(remoteCommandTitle("echo hello")).toBe("echo hello");
});

it("keeps mid-turn user steering at its original location", () => {
  const result = splitRemoteTurn({
    ...turn,
    items: [
      turn.items[0]!,
      turn.items[1]!,
      { id: "u2", type: "userMessage", text: "补充", detail: "" },
      turn.items[2]!,
      turn.items[3]!,
    ],
  });
  expect(result.users.map((i) => i.id)).toEqual(["u"]);
  expect(result.progress.map((i) => i.id)).toEqual(["p", "u2", "t"]);
});
it("uses Desktop read actions for rows and merges approved review gaps", () => {
  const item = {
    id: "c",
    type: "commandExecution",
    text: "cat a; cat b",
    detail: "both outputs",
    commandActions: ["a", "b"].map((name) => ({
      type: "read" as const,
      command: `cat ${name}`,
      name,
      path: `/project/${name}`,
      query: "",
    })),
  };
  const command = { id: "run", type: "commandExecution", text: "npm test", detail: "ok" };
  const groups = groupRemoteProgress([
    item,
    { id: "review", type: "automaticApprovalReview", status: "approved", text: "", detail: "" },
    command,
  ]);
  expect(groups).toHaveLength(1);
  const rows = remoteCommandRows(groups[0]!.items);
  expect(rows).toHaveLength(3);
  expect(rows[0]?.item.detail).toBe("both outputs");
  expect(remoteCommandGroupLabel(rows)).toBe("已读取 2 个文件并运行 1 条命令");
  expect(remoteCommandRows([command])).toHaveLength(1);
});

it("omits reasoning summaries without splitting commands or removing commentary", () => {
  const command = { id: "c1", type: "commandExecution", text: "cat file", detail: "output" };
  const reasoning = { id: "r1", type: "reasoning", text: "思考摘要", detail: "summary" };
  const commentary = {
    id: "note",
    type: "agentMessage",
    phase: "commentary",
    text: "进度说明",
    detail: "",
  };
  const groups = groupRemoteProgress([
    reasoning,
    command,
    { ...reasoning, id: "r2" },
    { ...command, id: "c2" },
    commentary,
    { ...command, id: "c3" },
  ]);
  expect(groups.map((group) => [group.kind, group.items.map((item) => item.id)])).toEqual([
    ["commands", ["c1", "c2"]],
    ["item", ["note"]],
    ["commands", ["c3"]],
  ]);
  expect(groupRemoteProgress([reasoning])).toEqual([]);
});

it("groups interleaved commands and computer tools without crossing messages", () => {
  const command = { id: "c1", type: "commandExecution", text: "sed file", detail: "output" };
  const tool = {
    id: "m1",
    type: "mcpToolCall",
    text: "查看镜像",
    detail: "screen",
    status: "completed",
  };
  const note = { id: "n1", type: "agentMessage", phase: "commentary", text: "进度", detail: "" };
  const user = { id: "u1", type: "userMessage", text: "补充", detail: "" };
  const groups = groupRemoteProgress([
    command,
    tool,
    { ...command, id: "c2" },
    { ...tool, id: "m2", status: "inProgress" },
    note,
    tool,
    user,
    command,
  ]);
  expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
    ["c1", "m1", "c2", "m2"],
    ["n1"],
    ["m1"],
    ["u1"],
    ["c1"],
  ]);
  expect(remoteCommandGroupLabel(remoteCommandRows(groups[0]!.items))).toBe(
    "正在运行 2 条命令并调用 2 次工具",
  );
  expect(remoteCommandGroupLabel(remoteCommandRows([tool, { ...tool, id: "m2" }]))).toBe(
    "已调用 2 次工具",
  );
});

it("uses the latest unfinished activity and returns to thinking between tool calls", async () => {
  const { remoteActivityHeader } = await import("./remote-turn-model");
  const command = {
    id: "c",
    type: "commandExecution",
    text: "/bin/zsh -lc 'npm test'",
    detail: "",
    status: "inProgress",
  };
  const tool = {
    id: "m",
    type: "mcpToolCall",
    text: "查看手机页面",
    detail: "",
    status: "inProgress",
  };
  expect(remoteActivityHeader([command]).label).toBe("正在运行 npm test");
  expect(remoteActivityHeader([command, tool]).label).toBe("查看手机页面");
  expect(remoteActivityHeader([command, { ...tool, status: "completed" }]).label).toBe(
    "正在运行 npm test",
  );
  expect(
    remoteActivityHeader([
      { ...command, status: "completed" },
      { ...tool, status: "failed" },
    ]),
  ).toEqual({ label: "正在思考", kind: null });
  expect(remoteActivityHeader([])).toEqual({ label: "正在思考", kind: null });
  expect(remoteActivityHeader([{ ...command, status: "interrupted" }]).label).toBe("正在思考");
});
it("uses read, search, file and web activity labels instead of a fixed thinking label", async () => {
  const { remoteActivityHeader } = await import("./remote-turn-model");
  const command = {
    id: "c",
    type: "commandExecution",
    text: "cat README.md",
    detail: "",
    status: "inProgress",
    commandActions: [
      {
        type: "read" as const,
        command: "cat README.md",
        name: "README.md",
        path: "/project/README.md",
        query: "",
      },
    ],
  };
  expect(remoteActivityHeader([command])).toEqual({ label: "正在读取 README.md", kind: "read" });
  expect(
    remoteActivityHeader([
      {
        ...command,
        commandActions: [{ ...command.commandActions[0]!, type: "search", query: "TODO" }],
      },
    ]).label,
  ).toBe("正在搜索 TODO");
  expect(
    remoteActivityHeader([
      { id: "p", type: "fileChange", status: "inProgress", text: "修改 2 个文件", detail: "" },
    ]).label,
  ).toBe("正在编辑文件");
  expect(
    remoteActivityHeader([
      { id: "w", type: "webSearch", status: "inProgress", text: "搜索网页", detail: "React docs" },
    ]).label,
  ).toBe("正在搜索网页 React docs");
});
