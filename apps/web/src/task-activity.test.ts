import { describe, expect, it } from "vitest";
import { describeActivity } from "./task-activity";

describe("具体活动说明", () => {
  it("展示多个字段的前后值和中文优先级", () => {
    expect(
      describeActivity("task.updated", {
        fields: ["title", "priority"],
        values: {
          title: { from: "旧标题", to: "新标题" },
          priority: { from: "medium", to: "high" },
        },
      }).map(({ summary }) => summary),
    ).toEqual(["将标题从「旧标题」改为「新标题」", "将优先级从「中」改为「高」"]);
  });
  it("描述保留完整前后内容供展开查看", () => {
    expect(
      describeActivity("task.updated", {
        fields: ["description"],
        values: { description: { from: "旧描述", to: "新描述" } },
      }),
    ).toEqual([{ summary: "修改了描述", before: "旧描述", after: "新描述" }]);
  });
  it("历史记录只显示已知字段，不虚构旧值", () => {
    expect(describeActivity("task.updated", { fields: ["title", "priority"] })[0]?.summary).toBe(
      "修改了标题、优先级（历史记录未保存前后值）",
    );
  });
  it("区分切换状态和仅调整列内顺序", () => {
    expect(
      describeActivity("task.moved", { status: { from: "todo", to: "in_progress" } })[0]?.summary,
    ).toBe("将状态从「待处理」改为「处理中」");
    expect(
      describeActivity("task.moved", { status: { from: "todo", to: "todo" } })[0]?.summary,
    ).toBe("调整了任务在「待处理」列内的顺序");
  });
  it("附件展示文件名，负责人展示名称，清空值明确说明", () => {
    expect(describeActivity("attachment.created", { filename: "证据.png" })[0]?.summary).toBe(
      "上传了附件「证据.png」",
    );
    expect(
      describeActivity("task.updated", {
        values: { assigneeIdentity: { from: { name: "张三" }, to: null } },
      })[0]?.summary,
    ).toBe("将负责人从「张三」改为「未设置」");
  });
});
