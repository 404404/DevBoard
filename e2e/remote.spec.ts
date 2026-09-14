import { expect, test } from "@playwright/test";

test("desktop has no Remote entry even when the mobile route is requested", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?remote=1");
  await expect(page.getByRole("button", { name: /切换项目，当前/ })).toBeVisible();
  await expect(page.locator(".remote-entry")).toHaveCount(0);
  await expect(page.getByRole("main", { name: "Codex Remote" })).toHaveCount(0);
});

test.describe("mobile Remote", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("official layout preserves search, changes, and approval access on small screens", async ({
    page,
  }, testInfo) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const titles = [
      "复刻 Codex Remote 移动界面",
      "整理发布说明",
      "修复偶发失败的集成测试",
      "检查导航更新",
      "排查重新连接的行为",
      "为任务列表添加搜索",
    ] as const;
    const projectId = "22222222-2222-4222-8222-222222222222";
    await page.route("**/api/v1/projects", (route) =>
      route.fulfill({
        json: {
          data: [
            {
              id: projectId,
              projectKey: "TASK",
              name: "lark-taskboard",
              description: "",
              kind: "codex",
              rootPaths: ["/projects/taskboard"],
              syncState: "synced",
              version: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
              membershipRole: "owner",
            },
          ],
        },
      }),
    );
    let approval = false;
    let executing = false;
    const turnFiles = ["src/navigation.ts", "src/second.ts", "src/third.ts", "src/fourth.ts"].map(
      (path) => ({
        path,
        previousPath: null,
        status: "modified",
        added: 2,
        removed: 1,
        binary: false,
      }),
    );
    const turnPatch = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-old\n+new\n+second\n`;
    await page.route(`**/api/v1/remote/threads/${id}/review?*`, (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("scope") !== "turn")
        return route.fulfill({
          json: {
            data: {
              repository: true,
              branch: "main",
              baseRef: "HEAD",
              scope: "branch",
              changedCount: 0,
              added: 0,
              removed: 0,
              countsComplete: true,
              files: [],
              message: "",
            },
          },
        });
      expect(query.get("turnId")).toBe("turn-1");
      const path = query.get("path");
      return route.fulfill({
        json: {
          data: path
            ? {
                file: turnFiles.find((file) => file.path === path),
                patch: query.get("view") === "file" ? "" : turnPatch(path),
                content: query.get("view") === "file" ? "new\nsecond\n" : "",
                binary: false,
                tooLarge: false,
                message: "",
                contentLabel: "当前内容",
              }
            : {
                repository: true,
                branch: "main",
                baseRef: null,
                scope: "turn",
                changedCount: 4,
                added: 8,
                removed: 4,
                countsComplete: true,
                files: turnFiles,
                message: "",
              },
        },
      });
    });
    await page.route("**/api/v1/remote/threads?*", async (route) => {
      const search = new URL(route.request().url()).searchParams.get("search") ?? "";
      await route.fulfill({
        json: {
          data: {
            nextCursor: null,
            threads: titles
              .map((title, index) => ({
                id: index === 0 ? id : `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
                title,
                preview: "",
                cwd: "/projects/taskboard",
                updatedAt: Date.now() / 1000 - (index > 3 ? 86400 : 0),
                status: index === 0 ? "active" : "idle",
              }))
              .filter((thread) => thread.title.includes(search)),
          },
        },
      });
    });
    await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
      route.fulfill({
        json: {
          data: {
            id,
            title: titles[0],
            cwd: "/projects/taskboard",
            model: "test-model",
            effort: "high",
            status: approval ? "waiting" : executing ? "active" : "idle",
            activeTurnId: approval || executing ? "turn-1" : null,
            historyComplete: true,
            turns: [
              {
                id: "turn-1",
                status: executing ? "inProgress" : "completed",
                startedAtMs: Date.now() - 88000,
                durationMs: executing ? null : 88000,
                error: "",
                diff: turnFiles.map((file) => turnPatch(file.path)).join(""),
                items: [
                  {
                    id: "u",
                    type: "userMessage",
                    text: "按官方示意图调整 Remote 界面，保留已经实现的功能。",
                    detail: "",
                  },
                  {
                    id: "p",
                    type: "agentMessage",
                    phase: "commentary",
                    text: "正在检查导航布局",
                    detail: "",
                  },
                  {
                    id: "c",
                    type: "commandExecution",
                    text: "npm test",
                    detail: "所有测试通过",
                    status: "completed",
                    durationMs: 1234,
                    exitCode: 0,
                  },
                  ...[2, 3, 4].map((index) => ({
                    id: `c${index}`,
                    type: "commandExecution",
                    text: `/bin/zsh -lc 'echo command ${index}'`,
                    detail: "output",
                    status: "completed",
                  })),
                  {
                    id: "a",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "任务列表和会话界面已更新。搜索放在底部，代码改动按文件展示，已有功能保持可用。",
                    detail: "",
                  },
                ].filter(
                  (item) => !executing || !("phase" in item) || item.phase !== "final_answer",
                ),
              },
            ],
            requests: approval
              ? [
                  {
                    id: 17,
                    kind: "command",
                    title: "是否允许 Codex 运行此命令？",
                    detail: "npm run test -- remote",
                    questions: [],
                    decisions: ["accept", "acceptForSession", "decline"],
                  },
                ]
              : [],
          },
        },
      }),
    );
    await page.goto("/?remote=1");
    await expect(page.getByRole("button", { name: "lark-taskboard", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "最近", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: titles[0] })).toHaveCount(0);
    await expect(page.getByLabel("搜索 Codex 任务")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("remote-official-list.png") });
    await page.getByRole("button", { name: "任务列表选项", exact: true }).click();
    await expect(page.getByText("本周 63%", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("remote-organize-menu.png") });
    await page.getByRole("button", { name: "按时间倒序排列", exact: true }).click();
    await expect(page.locator(".remote-thread-list li")).toHaveCount(6);
    await page.reload();
    await expect(page.locator(".remote-thread-list li")).toHaveCount(6);
    await page.getByRole("button", { name: "任务列表选项", exact: true }).click();
    await expect(page.getByRole("button", { name: "按时间倒序排列", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "最近优先", exact: true }).click();
    await expect(page.locator(".remote-project-toggle").first()).toHaveText("最近");
    await page.getByRole("button", { name: "任务列表选项", exact: true }).click();
    await page.getByRole("button", { name: "按项目", exact: true }).click();

    await page.getByRole("button", { name: "在lark-taskboard中新建任务" }).click();
    await expect(page.getByLabel("工作位置")).toHaveValue(projectId);
    await page.getByRole("button", { name: "取消新建任务" }).click();
    await page.getByRole("button", { name: "lark-taskboard", exact: true }).click();
    await expect(page.getByRole("button", { name: titles[0] })).toBeVisible();
    await page.getByLabel("搜索 Codex 任务").fill("导航");
    await expect(page.locator(".remote-thread-list li")).toHaveCount(1);
    await page.getByLabel("搜索 Codex 任务").fill("");
    await page.getByRole("button", { name: "新建 Codex 任务" }).click();
    await expect(page.getByLabel("工作位置")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("remote-official-new.png") });
    await page.getByRole("button", { name: "取消新建任务" }).click();
    await page.getByRole("button", { name: titles[0] }).click();
    await page.getByLabel("发送给 Codex").fill("保留这份审查草稿");
    await page.screenshot({ path: testInfo.outputPath("remote-official-conversation.png") });
    await expect(page.getByText("正在检查导航布局", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: /已更改 4 个文件/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看另外 1 个文件" })).toBeVisible();
    await expect(page.locator(".remote-diff-rows > button")).toHaveCount(4);
    await page.getByRole("button", { name: /已更改 4 个文件/ }).click();
    await expect(page.getByRole("button", { name: /已更改 4 个文件/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.getByRole("button", { name: /已更改 4 个文件/ }).click();
    await page.locator(".remote-progress > summary").click();
    await expect(page.getByText("正在检查导航布局", { exact: true })).toBeVisible();
    await expect(page.locator(".remote-progress > summary")).toHaveText("用时 1 分钟 28 秒");
    await expect(
      page.locator(".remote-tool > summary").filter({ hasText: "npm test" }),
    ).toBeHidden();
    await page.locator(".remote-command-group > summary").click();
    await expect(page.locator(".remote-command-group .remote-tool")).toHaveCount(4);
    await page.screenshot({ path: testInfo.outputPath("remote-command-group.png") });
    await page.locator(".remote-tool > summary").filter({ hasText: "npm test" }).click();
    await expect(page.getByText("所有测试通过", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看 src/navigation.ts 的改动" }).click();
    await expect(page.getByRole("dialog", { name: "代码审核", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "已更改 4 个文件" })).toBeVisible();
    await expect(page.getByLabel("src/navigation.ts 代码差异").locator(".addition")).toHaveCount(2);
    await page.getByRole("button", { name: "折叠所有差异" }).click();
    await expect(page.getByLabel("src/navigation.ts 代码差异")).toBeHidden();
    await page.getByRole("button", { name: "展开所有差异" }).click();
    await expect(page.getByLabel("src/navigation.ts 代码差异")).toBeVisible();
    await expect
      .poll(async () => {
        const header = await page
          .getByLabel("src/navigation.ts 的改动", { exact: true })
          .locator("header")
          .boundingBox();
        const scroll = await page.locator(".remote-review-scroll").boundingBox();
        return Math.abs(header!.y - scroll!.y);
      })
      .toBeLessThan(35);
    await page.screenshot({ path: testInfo.outputPath("remote-official-diff.png") });
    await page.getByRole("button", { name: "关闭审核" }).click();
    await expect(page.getByLabel("发送给 Codex")).toHaveValue("保留这份审查草稿");
    executing = true;
    await page.reload();
    await expect(page.getByText("正在检查导航布局", { exact: true })).toBeVisible();
    const thinking = page.getByRole("status").filter({ hasText: "正在思考" });
    await expect(thinking).toBeVisible();
    await expect(page.getByText("Codex 正在处理…", { exact: true })).toHaveCount(0);
    const label = page.locator(".remote-thinking").first();
    const position = await label.evaluate(
      (element) => getComputedStyle(element).backgroundPosition,
    );
    await expect
      .poll(() => label.evaluate((element) => getComputedStyle(element).backgroundPosition))
      .not.toBe(position);
    await page.screenshot({ path: testInfo.outputPath("remote-thinking-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: testInfo.outputPath("remote-thinking-dark.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(label).toHaveCSS("animation-name", "none");
    await expect(label).toHaveCSS("background-image", "none");
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

    executing = false;
    await expect(page.getByText("正在检查导航布局", { exact: true })).toBeHidden({
      timeout: 15000,
    });
    await expect(thinking).toHaveCount(0);
    await expect(page.locator(".remote-progress > summary")).toHaveText("用时 1 分钟 28 秒");
    approval = true;
    await page.reload();
    await expect(page.getByRole("button", { name: "允许一次", exact: true })).toBeInViewport();
    await page.getByLabel("发送给 Codex").fill("");
    await page.getByLabel("发送给 Codex").blur();
    await expect(page.getByRole("button", { name: "本次会话允许", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("remote-official-approval.png") });
    await page.getByLabel("发送给 Codex").fill("保留这份审查草稿");
    await page.setViewportSize({ width: 320, height: 430 });
    await expect(page.getByRole("button", { name: "允许一次", exact: true })).toBeInViewport();
    await expect(page.getByLabel("发送给 Codex")).toBeInViewport();
    expect(
      await page.locator(".remote-page").evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(false);
  });

  test("matches Desktop read groups, single command cards, images and steering order", async ({
    page,
  }, testInfo) => {
    const id = "33333333-3333-4333-8333-333333333333";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route(`**/api/v1/remote/threads/${id}/images/**`, (route) =>
      route.fulfill({ contentType: "image/png", body: png }),
    );
    await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
      route.fulfill({
        json: {
          data: {
            id,
            title: "Desktop 展示对齐",
            cwd: "/project",
            model: "test-model",
            effort: "high",
            status: "idle",
            activeTurnId: null,
            historyComplete: true,
            requests: [],
            turns: [
              {
                id: "t",
                status: "completed",
                startedAtMs: 1000,
                durationMs: 89000,
                workDurationMs: 85000,
                diff: "",
                error: "",
                items: [
                  {
                    id: "u",
                    type: "userMessage",
                    text: "请对齐界面",
                    detail: "",
                    images: [{ index: 0, name: "参考图.png" }],
                  },
                  {
                    id: "p",
                    type: "agentMessage",
                    phase: "commentary",
                    text: "先查看文件",
                    detail: "",
                  },
                  {
                    id: "r",
                    type: "commandExecution",
                    text: "/bin/zsh -lc 'cat a.ts; cat b.ts'",
                    detail: "source content",
                    status: "completed",
                    exitCode: 0,
                    commandActions: ["a.ts", "b.ts"].map((name) => ({
                      type: "read",
                      command: `cat ${name}`,
                      name,
                      path: `/project/${name}`,
                      query: "",
                    })),
                  },
                  { id: "summary1", type: "reasoning", text: "思考摘要", detail: "Public summary" },
                  {
                    id: "c1",
                    type: "commandExecution",
                    text: "/bin/zsh -lc 'npm test'",
                    detail: "tests passed",
                    status: "completed",
                    exitCode: 0,
                  },
                  {
                    id: "c2",
                    type: "commandExecution",
                    text: "/bin/zsh -lc 'npm run build'",
                    detail: "built",
                    status: "completed",
                    exitCode: 0,
                  },
                  { id: "u2", type: "userMessage", text: "也对齐图片", detail: "" },
                  {
                    id: "img",
                    type: "imageView",
                    text: "查看图片",
                    detail: "",
                    images: [{ index: 0, name: "结果图.png" }],
                  },
                  {
                    id: "single",
                    type: "commandExecution",
                    text: "/bin/zsh -lc 'git diff --check'",
                    detail: "",
                    status: "completed",
                    exitCode: 0,
                  },
                  {
                    id: "computer",
                    type: "mcpToolCall",
                    text: "查看镜像页面",
                    detail: "页面状态已读取",
                    status: "completed",
                    sections: [{ title: "工具", text: "cua_repl / js" }],
                  },
                  {
                    id: "f",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "已经对齐\n\n[查看文档](https://example.com/docs)",
                    detail: "",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    await page.goto(`/?remote=1&remoteThread=${id}`);
    await expect(page.getByText("已经对齐", { exact: true })).toBeVisible();
    const link = page.getByRole("link", { name: "查看文档", exact: true });
    await expect(link).toHaveAttribute("href", "https://example.com/docs");
    await expect(link).toHaveCSS("color", "rgb(0, 109, 204)");
    await expect(link).toHaveCSS("text-decoration-line", "underline");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(link).toHaveCSS("color", "rgb(98, 178, 255)");
    await page.emulateMedia({ colorScheme: "light" });

    await expect(page.locator(".remote-progress > summary")).toHaveText("用时 1 分钟 25 秒");
    await page.locator(".remote-progress > summary").click();
    await expect(page.getByText("思考摘要", { exact: true })).toHaveCount(0);
    await expect(page.locator(".remote-command-group")).toHaveCount(2);
    await expect(page.locator(".remote-command-group > summary").first()).toHaveText(
      "已读取 2 个文件并运行 2 条命令",
    );
    await page.locator(".remote-command-group > summary").first().click();
    await expect(page.locator(".remote-command-group").first().locator(".remote-tool")).toHaveCount(
      4,
    );
    await expect(page.getByText("已读取 a.ts", { exact: true })).toBeVisible();
    await expect(page.locator(".remote-progress-content .remote-user-message")).toHaveText(
      "也对齐图片",
    );
    const mixed = page.locator(".remote-command-group").last();
    await expect(mixed.locator("summary").first()).toHaveText("已运行 1 条命令并调用 1 次工具");
    await expect(page.getByText("已运行 git diff --check", { exact: true })).toBeHidden();
    await expect(page.getByText("查看镜像页面", { exact: true })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("remote-mixed-tools-collapsed.png") });
    await mixed.locator("summary").first().click();
    await page.getByText("已运行 git diff --check", { exact: true }).click();
    const card = page.locator(".remote-shell-card").last();
    await expect(card.getByText("Shell", { exact: true })).toBeVisible();
    await expect(card.getByText("无输出", { exact: true })).toBeVisible();
    await expect(card.getByText("成功", { exact: true })).toBeVisible();
    await expect(card.locator(".remote-shell-command")).toHaveText("$ git diff --check");
    await page.getByText("已查看 1 张图像", { exact: true }).click();
    await page.getByRole("button", { name: "查看图片 结果图.png", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "图片预览" }).getByRole("img")).toBeVisible();
    await page.getByRole("button", { name: "关闭图片预览" }).click();
    await expect(page.locator(".remote-tool > summary", { hasText: "查看镜像页面" })).toBeVisible();
    await expect(page.locator(".remote-tool > summary", { hasText: "cua_repl / js" })).toHaveCount(
      0,
    );
    await page.screenshot({ path: testInfo.outputPath("remote-desktop-parity.png") });
    expect(
      await page.locator(".remote-page").evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(false);
  });

  test("keeps a reader's position after a small upward scroll during live updates", async ({
    page,
  }) => {
    const id = "44444444-4444-4444-8444-444444444444";
    let reads = 0;
    await page.route(`**/api/v1/remote/threads/${id}`, (route) => {
      reads++;
      return route.fulfill({
        json: {
          data: {
            id,
            title: "实时滚动检查",
            cwd: "/project",
            model: "test-model",
            effort: "high",
            status: "active",
            activeTurnId: "t",
            historyComplete: true,
            requests: [],
            turns: [
              {
                id: "t",
                status: "inProgress",
                diff: "",
                error: "",
                items: Array.from({ length: 24 }, (_, i) => ({
                  id: `p${i}`,
                  type: "agentMessage",
                  phase: "commentary",
                  text: `进度 ${i + 1}`,
                  detail: "",
                })),
              },
            ],
          },
        },
      });
    });
    await page.goto(`/?remote=1&remoteThread=${id}`);
    const messages = page.locator(".remote-messages");
    await expect(page.getByText("进度 24", { exact: true })).toBeVisible();
    await expect
      .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(4);
    const before = await messages.evaluate((el) => {
      el.scrollTop -= 60;
      return el.scrollTop;
    });
    const readCount = reads;
    await expect.poll(() => reads).toBeGreaterThan(readCount);
    await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBe(before);
    await messages.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(4);
  });

  test("creates, sends, approves, resumes and stops via the real isolated bridge", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Remote", exact: true }).click();
    await expect(page.getByRole("heading", { name: "远程", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新建 Codex 任务" }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByRole("heading", { name: "有什么需要帮忙？" })).toBeVisible();
    const originalUrl = page.url();
    await expect(page.getByRole("button", { name: "模型设置" })).toHaveCount(0);
    await page.getByLabel("发送给 Codex").fill("检查项目，并汇报测试结果。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText("检查项目，并汇报测试结果。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "对话选项" }).click();
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "重命名任务" });
    for (const height of [844, 430]) {
      await page.setViewportSize({ width: 390, height });
      await expect
        .poll(async () => {
          const box = await renameDialog.boundingBox();
          return box ? Math.abs(box.y + box.height / 2 - height / 2) : 999;
        })
        .toBeLessThan(2);
      const box = await renameDialog.boundingBox();
      expect(Math.abs(box!.x + box!.width / 2 - 195)).toBeLessThan(2);
      await page.screenshot({ path: testInfo.outputPath(`remote-rename-${height}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("textbox", { name: "对话名称" }).fill("远程重命名验收");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "重命名任务" })).toHaveCount(0);
    await expect(page.locator(".remote-heading strong")).toHaveText("远程重命名验收");
    await expect(page.getByRole("button", { name: "允许一次", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "允许一次", exact: true }).click();
    await expect(page.getByText("Fake Codex 已完成浏览器验收执行", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
    await expect(page.getByLabel("发送给 Codex")).toHaveValue("");
    await expect(page.locator(".remote-composer-note")).toContainText("medium");
    await page.screenshot({ path: testInfo.outputPath("mobile-remote.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 430 });
    await expect(page.locator(".remote-composer")).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator(".remote-page")).toHaveCSS("background-color", "rgb(23, 23, 23)");
    await page.screenshot({ path: testInfo.outputPath("mobile-remote-dark.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "light" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    await page.getByLabel("发送给 Codex").fill("继续检查");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "允许一次", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "对话选项" }).click();
    await page.getByRole("button", { name: "停止 Codex" }).click();
    await expect(page.getByText("已停止", { exact: true }).last()).toBeVisible();
    await page.locator(".remote-progress > summary").last().click();
    await expect(page.getByText("Fake Codex 已中断", { exact: true })).toBeVisible();
    await page.reload();
    expect(page.url()).toBe(originalUrl);
    await expect(page.locator(".remote-heading strong")).toHaveText("远程重命名验收");
    await expect(page.getByText("Fake Codex 已完成浏览器验收执行", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "对话选项" }).click();
    await expect(page.getByRole("button", { name: "重命名", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Codex 模型" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "加载完整历史" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "压缩上下文" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "撰写消息" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("keeps the draft and original ID when Desktop becomes unavailable", async ({ page }) => {
    await page.goto("/?remote=1");
    await page.getByRole("button", { name: "新建 Codex 任务" }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByRole("heading", { name: "有什么需要帮忙？" })).toBeVisible();
    await page.getByLabel("发送给 Codex").fill("保留这份草稿");
    const originalUrl = page.url();
    await page.route("**/api/v1/remote/threads/*", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INVALID_REQUEST", message: "桌面连接不可用", requestId: "offline-test" },
        }),
      });
    });
    await expect(page.getByRole("alert")).toContainText("数据已更新，请刷新后重试。");
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel("发送给 Codex")).toHaveValue("保留这份草稿");
    expect(page.url()).toBe(originalUrl);
  });
});
