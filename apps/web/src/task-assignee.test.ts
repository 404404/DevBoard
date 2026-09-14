import { describe, expect, it } from "vitest";
import { assigneeFromSelection, currentAssignee } from "./task-assignee";

const first = {
  identity: { kind: "feishu", tenantKey: "a", userId: "same" } as const,
  name: "甲",
  avatarUrl: null,
  actorRole: "member" as const,
  projectRole: "viewer" as const,
};
const second = { ...first, identity: { ...first.identity, tenantKey: "b" }, name: "乙" };

describe("task assignee identity", () => {
  it("selects the current user by both tenant and user and never defaults a service to a person", () => {
    expect(
      currentAssignee([first, second], { kind: "feishu", tenantKey: "b", userId: "same" })?.name,
    ).toBe("乙");
    expect(
      currentAssignee([first, second], { kind: "service", serviceId: "codex" }),
    ).toBeUndefined();
  });
  it("decodes picker values into public Feishu objects and rejects service or legacy values", () => {
    expect(assigneeFromSelection('["feishu","b","same"]')).toEqual({
      kind: "feishu",
      tenantKey: "b",
      userId: "same",
    });
    expect(assigneeFromSelection("")).toBeNull();
    expect(() => assigneeFromSelection('["service","codex"]')).toThrow();
    expect(() => assigneeFromSelection("30000000-0000-4000-8000-000000000001")).toThrow();
  });
});
