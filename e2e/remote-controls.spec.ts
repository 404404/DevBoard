import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test("permissions and steering use the isolated owner, preserve drafts and never auto-approve", async ({
  page,
}, testInfo) => {
  const actions: {
    type: string;
    decision?: string;
    permissionToken?: string;
    turnId?: string;
    text?: string;
  }[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/remote/threads/") &&
      request.url().endsWith("/actions") &&
      request.method() === "POST"
    )
      actions.push(request.postDataJSON());
  });
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByLabel("发送给 Codex");
  await input.fill("权限与引导验收");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const permission = page.getByRole("region", { name: "权限审批" });
  await expect(permission).toContainText("访问网络");
  await expect(permission).toContainText("写入：/tmp/taskboard-report");
  await expect(permission.getByRole("button", { name: "本次会话允许" })).toBeVisible();
  await input.fill("只验证，不发布");
  await expect(page.getByRole("button", { name: "引导当前任务" })).toHaveCount(0);
  const approveBounds = await permission.getByRole("button", { name: "允许一次" }).boundingBox();
  const denyBounds = await permission
    .getByRole("button", { name: "拒绝", exact: true })
    .boundingBox();
  expect(approveBounds!.y).toBeLessThan(denyBounds!.y);
  await input.blur();
  await page.screenshot({ path: testInfo.outputPath("remote-permissions.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("remote-permissions-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 320, height: 430 });
  await expect(permission.getByRole("button", { name: "允许一次" })).toBeInViewport();
  await expect(input).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("remote-permissions-compact.png") });
  expect(actions.map((a) => a.type)).toEqual(["send"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await permission.getByRole("button", { name: "允许一次" }).click();
  await expect(permission).toHaveCount(0);
  expect(actions[1]).toMatchObject({
    type: "respond",
    decision: "accept",
    permissionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(actions[1]).not.toHaveProperty("permissions");
  await expect(input).toHaveValue("只验证，不发布");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "停止 Codex" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "审批方式", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "审批方式", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "审批方式" })).toBeVisible();
  await page.getByRole("button", { name: "关闭输入设置" }).click();
  await expect(page.getByRole("button", { name: "模型与推理强度" })).toBeEnabled();
  await page.getByRole("button", { name: "模型与推理强度" }).click();
  await expect(page.getByRole("dialog", { name: "模型设置" })).toBeVisible();
  await page.getByRole("button", { name: "关闭输入设置" }).click();
  expect(actions.map((a) => a.type)).toEqual(["send", "respond"]);
  await page.screenshot({ path: testInfo.outputPath("remote-queue-composer.png") });
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const queued = page.getByRole("article", { name: "排队消息" });
  await expect(queued).toContainText("只验证，不发布");
  await expect(queued).toContainText("排队中");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "停止 Codex" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("remote-queued-message.png") });
  await queued.getByRole("button").click();
  const queueMenu = page.getByRole("dialog", { name: "排队消息操作" });
  await expect(queueMenu.getByRole("button", { name: "编辑消息" })).toBeVisible();
  await expect(queueMenu.locator('[data-sf-symbol="pencil"]')).toBeVisible();
  await expect(queueMenu.locator('[data-sf-symbol="arrow.turn.down.right"]')).toBeVisible();
  await expect(queueMenu.locator('[data-sf-symbol="trash"]')).toBeVisible();
  await queueMenu.getByRole("button", { name: "取消消息" }).focus();
  await expect(queueMenu.getByRole("button", { name: "取消消息" })).toBeFocused();
  await expect(queueMenu.getByRole("button", { name: "取消消息" })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await page.screenshot({ path: testInfo.outputPath("remote-queue-menu.png") });
  await queueMenu.getByRole("button", { name: "编辑消息" }).click();
  await expect(queued).toHaveCount(0);
  await expect(input).toHaveValue("只验证，不发布");
  await input.fill("修改后的排队消息");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(queued).toContainText("修改后的排队消息");
  await page.reload();
  await expect(queued).toContainText("修改后的排队消息");
  await queued.getByRole("button").click();
  await queueMenu.getByRole("button", { name: "改为引导" }).click();
  await expect(queued).toHaveCount(0);
  await expect(
    page.locator(".remote-user-message").filter({ hasText: "修改后的排队消息" }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  expect(
    actions.filter((a) => a.type === "queue").map((a) => (a as { operation?: string }).operation),
  ).toEqual(["append", "take", "append", "steer"]);
  await input.fill("取消这条排队消息");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(queued).toContainText("取消这条排队消息");
  await queued.getByRole("button").click();
  await queueMenu.getByRole("button", { name: "取消消息" }).click();
  await expect(queued).toHaveCount(0);
  await input.fill("保留失败的引导");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(queued).toContainText("保留失败的引导");
  const failedKeys: string[] = [];
  await page.route("**/api/v1/remote/threads/*/actions", async (route) => {
    if (route.request().postDataJSON().operation !== "steer") return route.continue();
    failedKeys.push(route.request().headers()["idempotency-key"]!);
    await route.fulfill({
      status: 409,
      json: { error: { code: "INVALID_REQUEST", message: "测试：引导结果尚未确认" } },
    });
  });
  await queued.getByRole("button").click();
  await queueMenu.getByRole("button", { name: "改为引导" }).click();
  await expect(page.getByRole("alert")).toContainText("数据已更新，请刷新后重试。");
  await expect(input).toHaveValue("保留失败的引导");
  const actionsBeforeRefresh = actions.length;
  const refreshed = page.waitForResponse(
    (response) =>
      /\/remote\/threads\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "GET" &&
      response.ok(),
  );
  await page.getByRole("alert").getByRole("button", { name: "刷新", exact: true }).tap();
  await refreshed;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(input).toHaveValue("保留失败的引导");
  expect(actions).toHaveLength(actionsBeforeRefresh);
  await page.reload();
  await expect(input).toHaveValue("保留失败的引导");
  await queued.getByRole("button").click();
  await queueMenu.getByRole("button", { name: "改为引导" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(failedKeys).toHaveLength(2);
  expect(failedKeys[1]).toBe(failedKeys[0]);
  let readUnavailable = true;
  await page.route("**/api/v1/remote/threads/*", async (route) => {
    if (!readUnavailable || route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 503,
      json: { error: { code: "INVALID_REQUEST", message: "测试：桌面暂时断开" } },
    });
  });
  await page.getByRole("alert").getByRole("button", { name: "刷新", exact: true }).tap();
  await expect(
    page.getByRole("alert").filter({ hasText: "服务暂时无法连接，请稍后重试。" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await expect(input).toHaveValue("保留失败的引导");
  readUnavailable = false;
  await page
    .getByRole("alert")
    .filter({ hasText: "服务暂时无法连接，请稍后重试。" })
    .getByRole("button", { name: "刷新", exact: true })
    .tap();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await expect(input).toHaveValue("保留失败的引导");
  await page.unroute("**/api/v1/remote/threads/*");
  await page.unroute("**/api/v1/remote/threads/*/actions");
  await input.fill("");
  await queued.getByRole("button").click();
  await queueMenu.getByRole("button", { name: "取消消息" }).click();
  await expect(queued).toHaveCount(0);
  await input.fill("恢复后的新引导");
  await page.getByRole("button", { name: "发送消息", exact: true }).tap();
  await expect(queued).toContainText("恢复后的新引导");
  await queued.getByRole("button").tap();
  await queueMenu.getByRole("button", { name: "改为引导" }).tap();
  await expect(queued).toHaveCount(0);
  await expect(
    page.locator(".remote-user-message").filter({ hasText: "恢复后的新引导" }),
  ).toBeVisible();
  for (let index = 0; index < 3; index++) {
    await input.fill("连续补充同样的内容");
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "发送消息", exact: true }).tap();
    await expect(queued).toContainText("连续补充同样的内容");
    await queued.getByRole("button").tap();
    await queueMenu.getByRole("button", { name: "改为引导" }).tap();
    await expect(queued).toHaveCount(0);
    await expect(
      page.locator(".remote-user-message").filter({ hasText: "连续补充同样的内容" }),
    ).toHaveCount(index + 1);
    await expect(input).toBeEnabled();
  }
  await page.getByRole("button", { name: "停止 Codex" }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await input.fill("权限与引导验收");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await permission.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(permission).toHaveCount(0);
  expect(actions.at(-1)).toMatchObject({ type: "respond", decision: "decline" });
  await expect(page.getByRole("button", { name: "停止 Codex" })).toBeEnabled();
  await page.getByRole("button", { name: "停止 Codex" }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await input.fill("权限与引导验收");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await permission.getByRole("button", { name: "本次会话允许", exact: true }).click();
  await expect(permission).toHaveCount(0);
  expect(actions.at(-1)).toMatchObject({
    type: "respond",
    decision: "acceptForSession",
    permissionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await page.getByRole("button", { name: "停止 Codex" }).click();
});
