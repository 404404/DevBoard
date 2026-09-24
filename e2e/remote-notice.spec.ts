import { expect, test } from "./helpers/remote-test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const id = "22222222-2222-4222-8222-222222222222";
const thread = {
  id,
  title: "Remote 提示验收",
  cwd: "/preview",
  model: "test",
  effort: "medium",
  status: "idle",
  activeTurnId: null,
  historyComplete: true,
  requests: [],
  turns: [
    {
      id: "turn-1",
      status: "completed",
      diff: "",
      error: "",
      items: [{ id: "message-1", type: "userMessage", text: "请检查项目的最新改动", detail: "" }],
    },
  ],
};
const review = {
  repository: true,
  branch: "main",
  baseRef: "main",
  scope: "branch",
  changedCount: 1,
  countsComplete: true,
  added: 1,
  removed: 0,
  message: "",
  files: [],
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/v1/auth/config", (route) =>
    route.fulfill({ json: { data: { authMode: "development", feishuAppId: null } } }),
  );
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      json: {
        data: {
          actor: {
            identity: { kind: "service", serviceId: "local-admin" },
            name: "本地测试",
            avatarUrl: null,
            role: "admin",
          },
          csrfToken: "x".repeat(32),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    }),
  );
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/v1/remote/models", (route) => route.fulfill({ json: { data: [] } }));
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({ json: { data: thread } }),
  );
  await page.route(`**/api/v1/remote/threads/${id}/review?*`, (route) =>
    route.fulfill({ json: { data: review } }),
  );
});

test("connection notice keeps conversation and draft, refresh restores it", async ({
  page,
}, testInfo) => {
  await page.goto(`/?remote=1&remoteThread=${id}`);
  const input = page.getByLabel("发送给 Codex");
  await input.fill("保留这段草稿");
  await input.blur();
  await page.route(`**/api/v1/remote/threads/${id}`, (route) => route.abort("failed"));
  const alert = page.getByRole("alert").filter({ hasText: "网络连接中断" });
  await expect(alert).toBeVisible();
  await expect(alert).toHaveClass(/notice-bar/);
  expect((await alert.boundingBox())!.height).toBeLessThan(90);
  expect((await alert.locator(":scope > .sf-symbol").boundingBox())!.width).toBe(16);
  await expect(alert.getByRole("button", { name: "关闭提示" })).toHaveCount(0);
  await expect(page.getByText("请检查项目的最新改动", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Load failed|Failed to fetch/);
  await page.screenshot({ path: testInfo.outputPath("connection.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("connection-dark.png") });
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({ json: { data: thread } }),
  );
  await alert.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(input).toHaveValue("保留这段草稿");
});

test("upload notice preserves draft and uses the shared compact presentation", async ({
  page,
}, testInfo) => {
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await page.getByLabel("发送给 Codex").fill("保留上传草稿");
  await page.getByLabel("发送给 Codex").blur();
  await page.route("**/api/v1/remote/uploads", (route) => route.abort("failed"));
  await page
    .getByLabel("上传文件")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("preview") });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("上传网络连接中断");
  await expect(alert).toHaveClass(/notice-bar/);
  expect((await alert.boundingBox())!.height).toBeLessThan(100);
  await page.screenshot({ path: testInfo.outputPath("upload.png"), animations: "disabled" });
  await alert.getByRole("button", { name: "关闭提示" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByLabel("发送给 Codex")).toHaveValue("保留上传草稿");
});

test("execution and review notices never expose raw errors", async ({ page }, testInfo) => {
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({
      json: {
        data: {
          ...thread,
          turns: [
            { ...thread.turns[0], status: "failed", error: "raw secret stack /private/path" },
          ],
        },
      },
    }),
  );
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await expect(page.getByRole("alert")).toContainText("本次执行未完成");
  await expect(page.locator("body")).not.toContainText("raw secret");
  await page.getByRole("button", { name: "审核代码改动" }).click();
  await page.route(`**/api/v1/remote/threads/${id}/review?*`, (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: "INTERNAL_ERROR", message: "raw secret stack", requestId: "test" } },
    }),
  );
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").selectOption("unstaged");
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("暂时无法完成操作");
  await expect(alert).toHaveClass(/notice-bar/);
  expect((await alert.boundingBox())!.height).toBeLessThan(100);
  await expect(alert.getByRole("button", { name: "关闭提示" })).toHaveCount(0);
  await expect(dialog).not.toContainText("raw secret");
  await page.screenshot({ path: testInfo.outputPath("review.png"), animations: "disabled" });
  await page.route(`**/api/v1/remote/threads/${id}/review?*`, (route) =>
    route.fulfill({ json: { data: { ...review, scope: "unstaged" } } }),
  );
  await alert.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(alert).toHaveCount(0);
});
