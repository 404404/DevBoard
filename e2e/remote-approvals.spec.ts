import { test, expect } from "./helpers/remote-test";
import { describeRemoteApproval } from "../packages/contracts/src/remote-approvals";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const id = "11111111-1111-4111-8111-111111111131";
const token = "a".repeat(64);
async function openApproval(page: import("@playwright/test").Page, params: unknown) {
  const approval = { ...describeRemoteApproval("mcpServer/elicitation/request", params)!, token };
  let received: unknown;
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id,
          title: "授权测试",
          cwd: "/test",
          model: "test",
          effort: "medium",
          status: "waiting",
          activeTurnId: "turn",
          historyComplete: true,
          turns: [],
          requests: [
            {
              id: "request",
              kind: "elicitation",
              title: "授权",
              detail: "",
              questions: [],
              decisions: [],
              approval,
            },
          ],
        },
      },
    }),
  );
  await page.route(`**/api/v1/remote/threads/${id}/actions`, async (route) => {
    received = route.request().postDataJSON();
    await route.fulfill({ json: { data: {} } });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  return () => received;
}
test("Computer Use shows app and submits only the user's selected scope", async ({ page }) => {
  const received = await openApproval(page, {
    mode: "form",
    serverName: "computer-use",
    message: "允许 Computer Use 使用 Test App？",
    requestedSchema: { type: "object", properties: {} },
    _meta: { persist: ["session", "always"], tool_params: { app: "Test App" } },
  });
  await expect(page.getByText(/允许 Computer Use 使用 Test App/)).toBeVisible();
  await page.getByRole("button", { name: "始终允许", exact: true }).click();
  await expect.poll(received).toMatchObject({
    type: "respond",
    requestId: "request",
    approvalChoice: "always",
    approvalToken: token,
    content: {},
  });
});
test("MCP form requires input and preserves boolean and number types", async ({ page }) => {
  const received = await openApproval(page, {
    mode: "form",
    serverName: "test",
    message: "确认提交",
    requestedSchema: {
      type: "object",
      required: ["name", "count", "confirmed"],
      properties: {
        name: { type: "string", title: "名称", minLength: 1 },
        count: { type: "integer", title: "数量" },
        confirmed: { type: "boolean", title: "确认" },
      },
    },
  });
  await page.getByRole("button", { name: "确认并提交" }).click();
  expect(received()).toBeUndefined();
  await page.getByLabel("名称", { exact: true }).fill("测试");
  await page.getByLabel("数量", { exact: true }).fill("2");
  await page.getByLabel("确认", { exact: true }).selectOption("false");
  await page.getByRole("button", { name: "确认并提交" }).click();
  await expect
    .poll(received)
    .toMatchObject({ content: { name: "测试", count: 2, confirmed: false } });
});
test("external login and unsupported forms never expose an accept button", async ({ page }) => {
  await openApproval(page, {
    mode: "url",
    serverName: "plugin",
    message: "登录",
    url: "https://example.com/oauth",
  });
  await expect(page.getByRole("link", { name: "打开授权网站" })).toHaveAttribute(
    "href",
    "https://example.com/oauth",
  );
  await expect(page.getByRole("button", { name: "允许一次" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "拒绝", exact: true })).toBeVisible();
});

test("valid required empty string and array can be submitted", async ({ page }) => {
  const received = await openApproval(page, {
    mode: "form",
    serverName: "test",
    message: "空值表单",
    requestedSchema: {
      type: "object",
      required: ["name", "values"],
      properties: {
        name: { type: "string", maxLength: 0 },
        values: { type: "array", items: { type: "string" }, maxItems: 0 },
      },
    },
  });
  await page.getByRole("button", { name: "确认并提交" }).click();
  await expect.poll(received).toMatchObject({ content: { name: "", values: [] } });
});

test("unfilled optional prototype-named field remains absent", async ({ page }) => {
  const received = await openApproval(page, {
    mode: "form",
    message: "可选表单",
    requestedSchema: { type: "object", properties: { toString: { type: "string" } } },
  });
  await expect(page.getByLabel("toString", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "确认并提交" }).click();
  await expect.poll(received).toMatchObject({ content: {} });
});
