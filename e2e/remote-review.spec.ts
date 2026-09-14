import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test("native review sheet, inline hunks, file tree and reader preserve drafts without execution", async ({
  page,
}, testInfo) => {
  const id = "88888888-8888-4888-8888-888888888888";
  const changed = {
    path: "src/中文 文件.ts",
    previousPath: null,
    status: "modified",
    added: 2,
    removed: 1,
    binary: false,
  };
  const binary = {
    path: "assets/icon.bin",
    previousPath: null,
    status: "added",
    added: null,
    removed: null,
    binary: true,
  };
  const unchanged = {
    path: "README.md",
    previousPath: null,
    status: "unchanged",
    added: 0,
    removed: 0,
    binary: false,
  };
  let failing = false;
  let repository = true;
  const requests: { scope: string; path: string | null; all: boolean; view: string | null }[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/remote/") && request.method() !== "GET")
      writes.push(request.url());
  });
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id,
          title: "代码审核测试",
          cwd: "/project",
          model: "test",
          effort: "high",
          status: "idle",
          activeTurnId: null,
          historyComplete: true,
          requests: [],
          turns: [],
        },
      },
    }),
  );
  await page.route(`**/api/v1/remote/threads/${id}/review?*`, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const scope = query.get("scope") ?? "branch",
      path = query.get("path"),
      all = query.get("all") === "1",
      view = query.get("view");
    requests.push({ scope, path, all, view });
    if (failing)
      return route.fulfill({
        status: 409,
        json: { error: { code: "INVALID_REQUEST", message: "测试：读取失败，请重试" } },
      });
    if (path) {
      const file = path === binary.path ? binary : path === unchanged.path ? unchanged : changed;
      const patch =
        file === changed && view !== "file"
          ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-old code\n+const version = '${scope}';\n+const longLine = '${"long text ".repeat(10)}';\n`
          : "";
      return route.fulfill({
        json: {
          data: {
            file,
            patch,
            content:
              file === unchanged
                ? "Read me\n"
                : view === "file"
                  ? `const version = '${scope}';\nconst completeFile = true;\n`
                  : "",
            binary: file.binary,
            tooLarge: false,
            message: file.binary ? "二进制文件，无法显示文本差异" : "",
            contentLabel: scope === "staged" ? "暂存内容" : "当前内容",
          },
        },
      });
    }
    const files = repository && scope !== "turn" ? [changed, binary] : [];
    return route.fulfill({
      json: {
        data: {
          repository,
          branch: repository ? "main" : null,
          baseRef: scope === "branch" && repository ? "HEAD" : null,
          scope,
          changedCount: files.length,
          countsComplete: !files.length,
          added: files.length ? 2 : 0,
          removed: files.length ? 1 : 0,
          message: repository ? "" : "此任务目录不是 Git 仓库",
          files: all && repository ? [...files, unchanged] : files,
        },
      },
    });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await page.getByRole("textbox", { name: "发送给 Codex" }).fill("保留这条草稿");
  const shortcut = page.getByRole("button", { name: "审核代码改动" });
  const pill = await shortcut.boundingBox();
  expect(Math.abs(pill!.x + pill!.width / 2 - 195)).toBeLessThan(2);
  await shortcut.click();
  const dialog = page.getByRole("dialog", { name: "代码审核" });
  const half = await dialog.boundingBox();
  expect(half!.height).toBeCloseTo(844 * 0.55, 0);
  expect(half!.y).toBeGreaterThan(350);
  await page.keyboard.press("Tab");
  await dialog.focus();
  await expect(dialog).toHaveCSS("outline-style", "none");
  await expect(dialog.getByRole("combobox", { name: "审核范围" })).toHaveValue("branch");
  const diff = dialog.getByLabel(`${changed.path} 代码差异`);
  await expect(diff).toContainText("const version = 'branch'");
  await expect(diff.locator(".addition")).toHaveCount(2);
  await expect(diff.locator(".deletion")).toHaveCount(1);
  await expect(diff.locator(".hljs-keyword").first()).toHaveText("const");
  expect(await diff.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByText("diff --git", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("review-native-half.png") });
  await dialog.getByRole("button", { name: "展开审核面板" }).click();
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 1);
  await page.mouse.move(90, 30);
  await page.mouse.down();
  await page.mouse.move(90, 95, { steps: 6 });
  await expect.poll(async () => (await dialog.boundingBox())!.y).toBeGreaterThan(50);
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await dialog.boundingBox())!.height))
    .toBe(Math.round(844 * 0.55));
  await dialog.getByRole("button", { name: "展开审核面板" }).click();
  await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 1);
  await expect(dialog.getByText("二进制文件，无法显示文本差异")).toBeVisible();
  const hunk = dialog.locator(".remote-review-hunk").first();
  await hunk.locator("summary").click();
  await expect(diff).toBeHidden();
  await hunk.locator("summary").click();
  await expect(diff).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("review-native-expanded.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("review-native-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await dialog.getByRole("button", { name: `查看 ${changed.path}`, exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "中文 文件.ts" })).toBeVisible();
  await expect(dialog.getByLabel(`${changed.path} 文件内容`)).toContainText("completeFile");
  if (testInfo.project.name === "iphone-webkit") {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: ShareData) => {
          document.documentElement.dataset.sharedFile = data.files?.[0]?.name;
        },
      });
    });
    await dialog.getByRole("button", { name: "共享文件" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-shared-file", "中文 文件.ts");
  } else {
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "共享文件" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe("中文 文件.ts");
  }
  await page.screenshot({ path: testInfo.outputPath("review-native-reader.png") });
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(diff).toBeVisible();
  await dialog.getByRole("combobox").selectOption("staged");
  await expect(dialog.getByLabel(`${changed.path} 代码差异`)).toContainText(
    "const version = 'staged'",
  );
  await dialog.getByRole("tab", { name: "所有文件" }).click();
  await expect(dialog.getByRole("heading", { name: "文件", exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: `查看 ${changed.path}`, exact: true }),
  ).toBeHidden();
  await dialog.locator(".remote-review-directory > summary").filter({ hasText: "src" }).click();
  await expect(
    dialog.getByRole("button", { name: `查看 ${changed.path}`, exact: true }),
  ).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "搜索文件" });
  const searchBox = await search.boundingBox();
  expect(searchBox!.y).toBeGreaterThan(740);
  await page.screenshot({ path: testInfo.outputPath("review-native-tree.png") });
  await search.fill("中文");
  await expect(dialog.locator(".remote-review-search-file")).toHaveCount(1);
  await dialog.getByRole("button", { name: `查看 ${changed.path}`, exact: true }).click();
  await expect(dialog.getByLabel(`${changed.path} 文件内容`)).toContainText("'staged'");
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(search).toHaveValue("中文");
  await search.fill("");
  await dialog.getByRole("button", { name: "查看 README.md", exact: true }).click();
  await expect(dialog.getByLabel("README.md 文件内容")).toContainText("Read me");
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await dialog.getByRole("tab", { name: "已修改" }).click();
  await dialog.getByRole("combobox").selectOption("turn");
  await expect(dialog.getByText("此范围没有代码改动")).toBeVisible();
  failing = true;
  await dialog.getByRole("combobox").selectOption("unstaged");
  await expect(dialog.getByRole("alert").first()).toContainText("数据已更新");
  failing = false;
  repository = false;
  await expect(dialog.getByRole("alert").getByRole("button", { name: "关闭提示" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(dialog.getByText("此任务目录不是 Git 仓库")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 420 });
  await dialog.getByRole("tab", { name: "所有文件" }).click();
  await expect(search).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "关闭审核" })).toBeInViewport();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "关闭审核" }).click();
  await expect(page.getByRole("textbox", { name: "发送给 Codex" })).toHaveValue("保留这条草稿");
  await page.getByRole("button", { name: "对话选项" }).click();
  await page.getByRole("button", { name: "查看代码改动", exact: true }).click();
  await expect(dialog.getByRole("combobox")).toHaveValue("unstaged");
  expect(
    requests.some(
      (request) =>
        request.scope === "staged" && request.view === "file" && request.path === changed.path,
    ),
  ).toBe(true);
  await expect.poll(async () => (await dialog.boundingBox())!.y).toBeCloseTo(183, 1);
  const beforeDrag = await dialog.boundingBox();
  await page.mouse.move(90, beforeDrag!.y + 28);
  await page.mouse.down();
  await page.mouse.move(90, beforeDrag!.y + 118, { steps: 6 });
  const releaseTop = (await dialog.boundingBox())!.y;
  await dialog.evaluate((element) => {
    const positions: number[] = [];
    const start = performance.now();
    const sample = () => {
      if (!element.isConnected || performance.now() - start > 300) return;
      positions.push(element.getBoundingClientRect().top);
      document.documentElement.dataset.closePositions = JSON.stringify(positions);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.up();
  await expect(dialog).toBeHidden();
  const positions: number[] = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.closePositions ?? "[]"),
  );
  expect(positions.length).toBeGreaterThan(0);
  expect(Math.min(...positions)).toBeGreaterThanOrEqual(releaseTop - 2);
  await expect(dialog).toBeHidden();
  expect(writes).toEqual([]);
});
