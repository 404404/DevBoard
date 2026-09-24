import { expect, test } from "./helpers/remote-test";
import type { RemoteThread } from "@codexboard/contracts";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("live activity follows Desktop labels and keeps the same expandable group", async ({
  page,
}, testInfo) => {
  const id = "11111111-1111-4111-8111-111111111119";
  let waiting = false;
  let finished = false;
  const items: RemoteThread["turns"][number]["items"] = [
    { id: "user", type: "userMessage", text: "检查运行状态", detail: "" },
    {
      id: "old",
      type: "commandExecution",
      text: "echo earlier",
      detail: "earlier",
      status: "completed",
    },
    {
      id: "note",
      type: "agentMessage",
      phase: "commentary",
      text: "接着检查测试和界面。",
      detail: "",
    },
    {
      id: "cmd",
      type: "commandExecution",
      text: "/bin/zsh -lc 'npm test'",
      detail: "running tests",
      status: "inProgress",
    },
  ];
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/actions"))
      writes.push(request.url());
  });
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id,
          title: "动态活动状态",
          cwd: "/project",
          model: "test",
          effort: "high",
          status: waiting ? "waiting" : finished ? "idle" : "active",
          activeTurnId: finished ? null : "running",
          historyComplete: true,
          turns: [
            {
              id: "running",
              status: finished ? "completed" : "inProgress",
              diff: "",
              error: "",
              items,
            },
          ],
          requests: waiting
            ? [
                {
                  id: "approval",
                  kind: "command",
                  title: "是否允许运行？",
                  detail: "npm test",
                  questions: [],
                  decisions: ["accept", "decline"],
                },
              ]
            : [],
        },
      },
    }),
  );
  await page.goto(`/?remote=1&remoteThread=${id}`);
  const group = page.locator(".remote-activity-live");
  const header = group.locator(":scope > summary");
  const body = group.locator(".remote-activity-items");
  await expect(group).toHaveCount(1);
  await expect(header).toHaveText("正在运行 npm test");
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByText("正在思考", { exact: true })).toHaveCount(0);
  await expect(body).toBeHidden();
  await header.click();
  await expect(body).toBeVisible();
  await body.locator(".remote-tool > summary").click();
  await expect(body.getByText("running tests", { exact: true })).toBeVisible();

  items.push({
    id: "computer",
    type: "mcpToolCall",
    text: "查看手机页面",
    detail: "screen data",
    status: "inProgress",
  });
  await expect(header).toHaveText("查看手机页面", { timeout: 10000 });
  await expect(body).toBeVisible();
  await expect(body.locator(".remote-tool")).toHaveCount(2);
  items[4]!.status = "completed";
  await expect(header).toHaveText("正在运行 npm test", { timeout: 10000 });
  items[3]!.status = "completed";
  await expect(header).toHaveText("正在思考", { timeout: 10000 });
  await expect(body).toBeVisible();
  await header.click();
  await expect(body).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("desktop-thinking-group.png") });
  await header.click();
  await expect(body).toBeVisible();
  await expect(body.locator(".remote-tool")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("desktop-thinking-expanded.png") });

  const longCommand = `npm run build -- ${"very-long-path/".repeat(12)}`;
  items.push({
    id: "build",
    type: "commandExecution",
    text: longCommand,
    detail: "",
    status: "inProgress",
  });
  await expect(header).toHaveText(`正在运行 ${longCommand}`, { timeout: 10000 });
  await expect(body).toBeVisible();
  expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("desktop-running-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });

  waiting = true;
  await expect(page.getByRole("status")).toHaveText("等待你的回复", { timeout: 10000 });
  await expect(group).toHaveCount(0);
  await expect(page.locator(".remote-thinking")).toHaveCount(0);
  waiting = false;
  finished = true;
  items[5]!.status = "completed";
  items.push({
    id: "final",
    type: "agentMessage",
    phase: "final_answer",
    text: "检查完成",
    detail: "",
  });
  await expect(page.getByText("检查完成", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator(".remote-progress")).not.toHaveAttribute("open");
  expect(writes).toEqual([]);
});
