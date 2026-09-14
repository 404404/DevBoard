import { expect, test } from "@playwright/test";
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const qid = '["request_user_input_async","question",0]';
function fixture(active = false) {
  return {
    id,
    title: "问答与编辑",
    cwd: "/test",
    model: "test",
    effort: "medium",
    status: active ? "active" : "idle",
    activeTurnId: active ? "turn-1" : null,
    historyComplete: true,
    requests: [],
    editableMessage: active ? null : { turnId: "turn-1", itemId: "user", token: "a".repeat(64) },
    turns: [
      {
        id: "turn-1",
        status: active ? "inProgress" : "interrupted",
        diff: "",
        error: "",
        items: [
          { id: "user", type: "userMessage", text: "原始消息", detail: "" },
          {
            id: "question",
            type: "agentMessage",
            text: "从哪里上传？\n\n相册\n文件",
            detail: "",
            phase: "commentary",
            asyncQuestions: [
              {
                id: qid,
                title: "从哪里上传？",
                options: ["相册", "文件"],
                answer: null as string | null,
              },
            ],
          },
          {
            id: "final",
            type: "agentMessage",
            text: "等待测试",
            detail: "",
            phase: "final_answer",
          },
        ],
      },
    ],
  };
}
for (const active of [true, false])
  test(`answer async question directly while active=${active}`, async ({ page }, testInfo) => {
    const thread = fixture(active);
    await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
      route.fulfill({ json: { data: thread } }),
    );
    const actions: unknown[] = [];
    await page.route(`**/api/v1/remote/threads/${id}/actions`, async (route) => {
      const action = route.request().postDataJSON();
      actions.push(action);
      thread.turns[0]!.items[1]!.asyncQuestions![0]!.answer = action.answers[qid];
      await route.fulfill({ json: { data: {} } });
    });
    await page.goto(`/?remote=1&remoteThread=${id}`);
    const answer = page.getByRole("button", { name: "回答问题", exact: true });
    await expect(page.getByText("从哪里上传？", { exact: true })).toBeVisible();
    await expect(page.getByText("相册", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "从哪里上传？" })).toHaveCount(0);
    await expect(answer).toHaveCSS("border-top-width", "1px");
    await expect(answer.locator("svg")).toBeVisible();
    await expect(page.getByRole("button", { name: "编辑消息", exact: true })).toHaveCount(
      active ? 0 : 1,
    );
    await page.screenshot({ path: testInfo.outputPath("collapsed-questions.png") });
    await answer.click();
    await expect(page.getByRole("button", { name: "提交回答" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("answer-form.png") });
    await page.getByRole("radio", { name: "相册", exact: true }).check();
    await page.getByRole("textbox", { name: "从哪里上传？" }).fill("相册中的录屏");
    await page.getByRole("button", { name: "提交回答" }).click();
    await expect(page.getByText("相册中的录屏", { exact: true })).toBeVisible();
    expect(actions).toEqual([
      { type: "answer", itemId: "question", answers: { [qid]: "相册中的录屏" } },
    ]);
    await page.reload();
    await expect(page.getByText("已回答 · 从哪里上传？")).toBeVisible();
    await expect(page.getByRole("button", { name: "回答问题", exact: true })).toHaveCount(0);
  });
test("stopped message editing preserves drafts on failure and replaces via dedicated edit action", async ({
  page,
}) => {
  const thread = fixture();
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({ json: { data: thread } }),
  );
  const actions: unknown[] = [];
  await page.route(`**/api/v1/remote/threads/${id}/actions`, async (route) => {
    const action = route.request().postDataJSON();
    actions.push(action);
    if (actions.length === 1) {
      await route.fulfill({
        status: 503,
        json: { error: { code: "SERVICE_UNAVAILABLE", message: "unavailable" } },
      });
      return;
    }
    thread.turns[0]!.items[0]!.text = action.text;
    thread.editableMessage = null;
    await route.fulfill({ json: { data: {} } });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await page.getByLabel("发送给 Codex").fill("另外一份未发送草稿");
  const edit = page.getByRole("button", { name: "编辑消息", exact: true });
  await expect(edit).toHaveText("");
  await expect(edit.locator("svg")).toHaveAttribute("viewBox", "0 0 21 21");
  await edit.click();
  await expect(page.getByLabel("编辑消息内容")).toHaveValue("原始消息");
  await page.getByLabel("编辑消息内容").fill("修改后的消息");
  await page.getByRole("button", { name: "保存并重新执行" }).click();
  await expect(page.getByLabel("编辑消息内容")).toHaveValue("修改后的消息");
  await expect(page.getByRole("form", { name: "编辑已发送消息" }).getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "保存并重新执行" }).click();
  await expect(page.locator(".remote-user-message")).toHaveText("修改后的消息");
  await expect(page.getByLabel("发送给 Codex")).toHaveValue("另外一份未发送草稿");
  expect(actions).toEqual(
    [0, 1].map(() => ({
      type: "edit",
      turnId: "turn-1",
      editToken: "a".repeat(64),
      text: "修改后的消息",
    })),
  );
});

test("user messages can be copied while active or stopped, with visible failure guidance", async ({
  page,
}) => {
  const thread = fixture(true);
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({ json: { data: thread } }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedText = text;
        },
      },
    });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  const copy = page.getByRole("button", { name: "复制消息", exact: true });
  await copy.click();
  await expect(page.locator("html")).toHaveAttribute("data-copied-text", "原始消息");
  await expect(copy).toHaveText("已复制");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    document.execCommand = () => false;
  });
  await copy.click();
  await expect(
    page.getByRole("status").filter({ hasText: "请长按或选中文本手动复制" }),
  ).toBeVisible();
  thread.status = "idle";
  thread.activeTurnId = null;
  thread.turns[0]!.status = "interrupted";
  await page.reload();
  await page.getByRole("button", { name: "复制消息", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-copied-text", "原始消息");
});

test("multiple questions stay collapsed and cancelling retains answer drafts", async ({
  page,
}, testInfo) => {
  const thread = fixture();
  thread.turns[0]!.items[1]!.asyncQuestions!.push({
    id: "freeform",
    title: "补充说明",
    options: [],
    answer: null,
  });
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({ json: { data: thread } }),
  );
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await expect(page.getByRole("textbox", { name: "补充说明" })).toHaveCount(0);
  await page.getByRole("button", { name: "回答问题", exact: true }).click();
  await page.getByRole("radio", { name: "文件", exact: true }).check();
  await page.getByRole("textbox", { name: "补充说明" }).fill("中文测试\n第二行 123");
  await expect(page.getByRole("button", { name: "提交回答" })).toBeEnabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.getByRole("button", { name: "回答问题", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "补充说明" })).toHaveValue("中文测试\n第二行 123");
  await expect(page.getByRole("radio", { name: "文件", exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("multiple-questions.png") });
});
