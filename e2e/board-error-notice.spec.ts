import { expect, test } from "./helpers/remote-test";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "codex",
  projectKey: "TEST",
  name: "提示验收项目",
  description: "",
  rootPaths: [],
  syncState: "synced",
  version: 1,
  membershipRole: "owner",
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
  archivedAt: null,
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
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { data: [project] } }));
  await page.route("**/api/v1/projects/*/board", (route) =>
    route.fulfill({ json: { data: { project, tasks: [] } } }),
  );
});

test("initial connection failure stays compact and retries successfully", async ({ page }) => {
  await page.route("**/api/v1/auth/config", (route) => route.abort("failed"));
  await page.goto("/");
  const notice = page.locator(".query-notice");
  await expect(notice).toContainText("网络连接中断");
  expect((await notice.boundingBox())!.height).toBeLessThan(100);
  await expect(page.locator(".session-state--error, .query-error")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/Load failed|Failed to fetch/);
  await page.unroute("**/api/v1/auth/config");
  await page.route("**/api/v1/auth/config", (route) =>
    route.fulfill({ json: { data: { authMode: "development", feishuAppId: null } } }),
  );
  await notice.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".kanban")).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("background project failure retains board and uses controlled copy", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.locator(".kanban")).toBeVisible();
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: "INTERNAL_ERROR", message: "secret raw stack /private/database" } },
    }),
  );
  const notice = page.locator(".query-notice");
  await expect(notice).toContainText("任务暂时无法加载", { timeout: 12000 });
  await expect(page.locator(".kanban")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("secret raw stack");
  expect((await notice.boundingBox())!.height).toBeLessThan(100);
  await page.screenshot({
    path: testInfo.outputPath("notice.png"),
    fullPage: true,
  });
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { data: [project] } }));
  await notice.getByRole("button", { name: "重试", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator(".kanban")).toBeVisible();
});

test("background board failure retains existing columns", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".kanban")).toBeVisible();
  await page.route("**/api/v1/projects/*/board", (route) => route.abort("failed"));
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({ json: { data: [{ ...project, version: 2 }] } }),
  );
  await expect(page.locator(".query-notice")).toContainText("网络连接中断", { timeout: 12000 });
  await expect(page.locator(".kanban")).toBeVisible();
  await expect(page.locator(".query-error")).toHaveCount(0);
});
