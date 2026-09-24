import { expect, test } from "./helpers/remote-test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("turn diff card opens its historical sheet, selects files and returns to the draft", async ({
  page,
}, testInfo) => {
  const id = "55555555-5555-4555-8555-555555555555";
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].map((path) => ({
    path,
    previousPath: null,
    status: "modified",
    added: 1,
    removed: 1,
    binary: false,
  }));
  const patch = (path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id,
          title: "回合改动",
          cwd: "/project",
          model: "test",
          effort: "medium",
          status: "idle",
          activeTurnId: null,
          historyComplete: true,
          requests: [],
          turns: [
            {
              id: "historical",
              status: "completed",
              durationMs: 1000,
              error: "",
              diff: files.map((file) => patch(file.path)).join(""),
              items: [
                {
                  id: "answer",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "已完成本轮修改。",
                  detail: "",
                },
              ],
            },
            { id: "latest", status: "completed", error: "", diff: "", items: [] },
          ],
        },
      },
    }),
  );
  await page.route(`**/api/v1/remote/threads/${id}/review?*`, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const turn = query.get("scope") === "turn";
    if (turn) expect(query.get("turnId")).toBe("historical");
    const path = query.get("path");
    return route.fulfill({
      json: {
        data: path
          ? {
              file: files.find((file) => file.path === path),
              patch: query.get("view") === "file" ? "" : patch(path),
              content: query.get("view") === "file" ? "new\n" : "",
              binary: false,
              tooLarge: false,
              message: "",
              contentLabel: "当前内容",
            }
          : {
              repository: true,
              branch: "main",
              baseRef: null,
              scope: turn ? "turn" : "branch",
              changedCount: turn ? 4 : 0,
              added: turn ? 4 : 0,
              removed: turn ? 4 : 0,
              countsComplete: true,
              files: turn ? files : [],
              message: "",
            },
      },
    });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  const input = page.getByLabel("发送给 Codex");
  await input.fill("保留草稿");
  const toggle = page.getByRole("button", { name: /已更改 4 个文件/ });
  await expect(toggle).toBeVisible();
  const answer = await page.getByText("已完成本轮修改。", { exact: true }).boundingBox();
  const card = await toggle.boundingBox();
  expect(card!.y).toBeGreaterThan(answer!.y);
  await expect(page.locator(".remote-diff-rows > button")).toHaveCount(4);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.getByRole("button", { name: "查看 src/b.ts 的改动" }).click();
  const dialog = page.getByRole("dialog", { name: "代码审核" });
  await expect(dialog.getByRole("heading", { name: "已更改 4 个文件" })).toBeVisible();
  await expect(dialog.getByLabel("src/b.ts 代码差异")).toBeInViewport();
  await dialog.getByRole("button", { name: "折叠所有差异" }).click();
  await expect(dialog.locator(".remote-review-hunk[open]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "展开所有差异" }).click();
  await expect(dialog.locator(".remote-review-hunk[open]").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("turn-diff-sheet.png") });
  await dialog.getByRole("button", { name: "查看 src/b.ts", exact: true }).click();
  await expect(dialog.getByLabel("src/b.ts 文件内容")).toContainText("new");
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭审核" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue("保留草稿");
  await page.getByRole("button", { name: "查看另外 1 个文件" }).click();
  await expect(page.getByRole("heading", { name: "已更改 4 个文件" })).toBeVisible();
});
