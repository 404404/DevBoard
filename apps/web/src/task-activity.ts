import type { ActivityView } from "@codexboard/contracts";
import { TASK_STATUS_META } from "./task-status";

const fields: Record<string, string> = {
  title: "标题",
  description: "描述",
  priority: "优先级",
  status: "状态",
  labels: "标签",
  assigneeIdentity: "负责人",
  startAt: "开始时间",
  dueAt: "截止时间",
  recurrence: "重复规则",
  developmentContextId: "开发上下文",
  links: "链接",
};
const priorities: Record<string, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function valueText(field: string, value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && !value.length)
  )
    return "未设置";
  if (field === "status" && typeof value === "string")
    return TASK_STATUS_META[value as keyof typeof TASK_STATUS_META]?.label ?? value;
  if (field === "priority" && typeof value === "string") return priorities[value] ?? value;
  if (Array.isArray(value)) return value.map(String).join("、");
  if (typeof value === "object")
    return typeof record(value).name === "string"
      ? String(record(value).name)
      : JSON.stringify(value, null, 2);
  if (
    (field === "startAt" || field === "dueAt") &&
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value))
  )
    return new Date(value).toLocaleString("zh-CN");
  return String(value);
}
export interface ActivityDescription {
  readonly summary: string;
  readonly before?: string;
  readonly after?: string;
}

export function describeActivity(
  kind: string,
  changes: ActivityView["changes"],
): readonly ActivityDescription[] {
  if (kind === "task.comment_pending") return [{ summary: "添加了待执行评论，任务已设为待处理" }];
  const values = record(changes.values);
  if (kind === "task.updated") {
    const details = Object.entries(values).flatMap(([field, raw]) => {
      const change = record(raw);
      if (
        !("from" in change) ||
        !("to" in change) ||
        JSON.stringify(change.from) === JSON.stringify(change.to)
      )
        return [];
      const before = valueText(field, change.from),
        after = valueText(field, change.to);
      const name = fields[field] ?? field;
      return [
        field === "description" || before.length + after.length > 180
          ? { summary: `修改了${name}`, before, after }
          : { summary: `将${name}从「${before}」改为「${after}」` },
      ];
    });
    if (details.length) return details;
    const names = Array.isArray(changes.fields)
      ? changes.fields
          .filter((field): field is string => typeof field === "string")
          .map((field) => fields[field] ?? field)
      : [];
    return [
      {
        summary: names.length
          ? `修改了${names.join("、")}（历史记录未保存前后值）`
          : "修改了任务属性（历史记录未保存字段明细）",
      },
    ];
  }
  const status = record(changes.status);
  if (
    ["task.moved", "task.execution_started", "task.execution_completed"].includes(kind) &&
    "from" in status &&
    "to" in status
  ) {
    const transition =
      status.from === status.to
        ? `调整了任务在「${valueText("status", status.to)}」列内的顺序`
        : `将状态从「${valueText("status", status.from)}」改为「${valueText("status", status.to)}」`;
    return [
      {
        summary: `${kind === "task.execution_started" ? "启动了执行，" : kind === "task.execution_completed" ? "执行完成，" : ""}${transition}`,
      },
    ];
  }
  const labels: Record<string, string> = {
    "task.created": "创建了任务",
    "task.moved": "移动了任务",
    "task.archived": "归档了任务",
    "task.restored": "恢复了任务",
    "task.reassigned": "重新分配了项目",
    "task.creation_failed": "创建失败并撤销了任务",
    "comment.created": "添加了评论",
    "comment.updated": "编辑了评论",
    "comment.deleted": "删除了评论",
    "attachment.created": "上传了附件",
    "attachment.deleted": "删除了附件",
    "relation.created": "添加了关系",
    "relation.deleted": "删除了关系",
  };
  const target = changes.filename ?? changes.targetIdentifier ?? changes.identifier;
  return [
    {
      summary: `${labels[kind] ?? "记录了任务操作"}${typeof target === "string" ? `「${target}」` : ""}`,
    },
  ];
}
