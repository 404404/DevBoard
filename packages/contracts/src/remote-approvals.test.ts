import { expect, it } from "vitest";
import { describeRemoteApproval, buildRemoteApprovalResponse } from "./remote-approvals.js";

const method = "mcpServer/elicitation/request";
const app = {
  mode: "form",
  serverName: "computer-use",
  message: 'Allow Computer Use to use "Test"?',
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "computer-use",
    tool_name: "getApp",
    tool_params: { app: "Test" },
    persist: ["session", "always"],
  },
};
it("shows app details and only advertised persistence scopes", () => {
  const view = describeRemoteApproval(method, app)!;
  expect(view.details).toContain('"app": "Test"');
  expect(view.choices.map((c) => c.id)).toEqual([
    "accept",
    "session",
    "always",
    "decline",
    "cancel",
  ]);
  expect(buildRemoteApprovalResponse(method, app, "always", {})).toEqual({
    action: "accept",
    content: {},
    _meta: { persist: "always" },
  });
  expect(() => buildRemoteApprovalResponse(method, { ...app, _meta: {} }, "always", {})).toThrow();
});
it("validates required typed fields, enums, numeric limits and rejects unknown keys", () => {
  const form = {
    ...app,
    _meta: {},
    requestedSchema: {
      type: "object",
      required: ["count", "confirmed"],
      properties: {
        count: { type: "integer", minimum: 1, maximum: 5 },
        confirmed: { type: "boolean" },
        name: { type: "string", enum: ["a", "b"] },
      },
    },
  };
  expect(
    buildRemoteApprovalResponse(method, form, "accept", { count: 2, confirmed: false }),
  ).toMatchObject({ content: { count: 2, confirmed: false } });
  for (const content of [
    { count: 0, confirmed: true },
    { count: 2 },
    { count: 2, confirmed: true, extra: "x" },
    { count: 2, confirmed: true, name: "c" },
  ]) {
    expect(() => buildRemoteApprovalResponse(method, form, "accept", content)).toThrow();
  }
});
it("never approves unsupported schemas or disabled execution-bound requests", () => {
  for (const requestedSchema of [
    { type: "object", properties: { nested: { type: "object" } } },
    { type: "object", properties: {}, allOf: [] },
    { type: "object", properties: { value: { type: "string", pattern: "secret" } } },
  ]) {
    const p = { ...app, requestedSchema };
    expect(describeRemoteApproval(method, p)!.blockedReason).toBeTruthy();
    expect(() => buildRemoteApprovalResponse(method, p, "accept", {})).toThrow();
    expect(buildRemoteApprovalResponse(method, p, "decline", {})).toMatchObject({
      action: "decline",
      content: null,
    });
  }
  const disabled = { ...app, _meta: { ...app._meta, approveDisabled: true } };
  expect(() => buildRemoteApprovalResponse(method, disabled, "accept", {})).toThrow();
});
it("provides safe external links without pretending OAuth completed", () => {
  const p = {
    mode: "url",
    serverName: "codex_apps",
    url: "https://example.com/oauth",
    message: "Connect",
  };
  expect(describeRemoteApproval(method, p)!.url).toBe(p.url);
  expect(() => buildRemoteApprovalResponse(method, p, "accept", {})).toThrow();
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "http://example.com",
  ]) {
    expect(describeRemoteApproval(method, { ...p, url })!.url).toBeUndefined();
  }
});
it("returns exact advertised structured command decisions", () => {
  const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } };
  const p = { command: "npm test", availableDecisions: ["accept", decision, "decline"] };
  const view = describeRemoteApproval("item/commandExecution/requestApproval", p)!;
  expect(view.choices).toHaveLength(3);
  expect(
    buildRemoteApprovalResponse("item/commandExecution/requestApproval", p, "decision-1", {}),
  ).toEqual(decision);
  expect(() =>
    buildRemoteApprovalResponse("item/commandExecution/requestApproval", p, "decision-9", {}),
  ).toThrow();
});

it("accepts advertised array selections and refuses extra or duplicate values", () => {
  const p = {
    ...app,
    requestedSchema: {
      type: "object",
      required: ["scopes"],
      properties: {
        scopes: {
          type: "array",
          items: { type: "string", enum: ["read", "write"] },
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
        },
      },
    },
  };
  expect(buildRemoteApprovalResponse(method, p, "accept", { scopes: ["read"] })).toMatchObject({
    content: { scopes: ["read"] },
  });
  for (const scopes of [[], ["admin"], ["read", "read"]])
    expect(() => buildRemoteApprovalResponse(method, p, "accept", { scopes })).toThrow();
});
it("execution-bound confirmation never offers saved approval", () => {
  const p = {
    ...app,
    _meta: {
      ...app._meta,
      tool_name: "sites.execute_database_delete",
      tool_params: { confirmation_summary: "delete one record", plan_token: "binding" },
    },
  };
  expect(describeRemoteApproval(method, p)!.choices.map((c) => c.id)).toEqual([
    "accept",
    "decline",
    "cancel",
  ]);
  expect(() => buildRemoteApprovalResponse(method, p, "always", {})).toThrow();
});

it("does not discard array-level enums", () => {
  const p = {
    ...app,
    requestedSchema: {
      type: "object",
      properties: { values: { type: "array", items: { type: "string" }, enum: [["allowed"]] } },
    },
  };
  expect(describeRemoteApproval(method, p)!.blockedReason).toBeTruthy();
  expect(() => buildRemoteApprovalResponse(method, p, "accept", { values: ["other"] })).toThrow();
});

it("treats unfilled prototype-named fields as absent", () => {
  const p = {
    ...app,
    requestedSchema: { type: "object", properties: { toString: { type: "string" } } },
  };
  expect(buildRemoteApprovalResponse(method, p, "accept", {})).toMatchObject({ content: {} });
});
