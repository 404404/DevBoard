import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("reopening a conversation waits for fresh data instead of rendering cached history", async ({
  page,
}) => {
  const id = "88888888-8888-4888-8888-888888888888";
  let secondVisit = false;
  let releaseRead = () => {};
  const freshRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route("**/api/v1/remote/threads?*", (route) =>
    route.fulfill({
      json: {
        data: {
          threads: [
            {
              id,
              title: "同步测试",
              preview: "",
              cwd: "/project",
              updatedAt: Date.now(),
              status: "idle",
            },
          ],
          nextCursor: null,
        },
      },
    }),
  );
  await page.route(`**/api/v1/remote/threads/${id}`, async (route) => {
    const fresh = secondVisit;
    if (fresh) await freshRead;
    await route.fulfill({
      json: {
        data: {
          id,
          title: "同步测试",
          cwd: "/project",
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
              items: [
                {
                  id: "message-1",
                  type: "userMessage",
                  text: fresh ? "最新消息" : "缓存里的旧消息",
                  detail: "",
                },
              ],
            },
          ],
        },
      },
    });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await expect(page.getByText("缓存里的旧消息", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回任务", exact: true }).tap();
  await page.getByRole("button", { name: "最近", exact: true }).tap();
  secondVisit = true;
  await page.locator(".remote-thread-list button").filter({ hasText: "同步测试" }).tap();
  try {
    await expect(page.getByText("正在连接桌面对话…", { exact: true })).toBeVisible();
    await expect(page.getByText("缓存里的旧消息", { exact: true })).toHaveCount(0);
  } finally {
    releaseRead();
  }
  await expect(page.getByText("最新消息", { exact: true })).toBeVisible();
  await expect(page.getByText("缓存里的旧消息", { exact: true })).toHaveCount(0);
});
