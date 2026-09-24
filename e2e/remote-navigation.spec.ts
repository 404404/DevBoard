import { expect, test } from "./helpers/remote-test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("initial loading does not render the project list beneath it", async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/remote/threads?*", async (route) => {
    await ready;
    await route.fulfill({ json: { data: { threads: [], nextCursor: null } } });
  });
  try {
    await page.goto("/?remote=1");
    await expect(page.getByText("正在加载任务…", { exact: true })).toBeVisible();
    await expect(page.locator(".remote-project-heading")).toHaveCount(0);
    await expect(page.locator(".remote-project-group")).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "最近", exact: true })).toBeVisible();
  await expect(page.getByText("正在加载任务…", { exact: true })).toHaveCount(0);
});

test("pagination appears only at the end of an expanded task group", async ({ page }) => {
  await page.route("**/api/v1/remote/threads?*", (route) => {
    const next = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({
      json: {
        data: {
          nextCursor: next ? null : "older",
          threads: [
            {
              id: next
                ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              title: next ? "更早的任务" : "最新的任务",
              preview: "",
              cwd: "/unassigned",
              updatedAt: next ? 1 : 2,
              status: "idle",
            },
          ],
        },
      },
    });
  });
  await page.goto("/?remote=1");
  const group = page.locator(".remote-recent-group");
  await expect(group).toBeVisible();
  await expect(page.getByRole("button", { name: "加载更多任务", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "展开显示" })).toHaveCount(0);
  await page.getByRole("button", { name: "最近", exact: true }).click();
  const more = group.getByRole("button", { name: "展开显示" });
  await expect(group.locator(".remote-thread-list > li").last()).toContainText("展开显示");
  await more.click();
  await expect(group.getByRole("button", { name: "更早的任务", exact: true })).toBeVisible();
  await expect(more).toHaveCount(0);
});

test("new task accepts an editable draft and carries it into the created conversation", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  const draft = page.getByRole("textbox", { name: "新任务消息" });
  await expect(draft).toBeEditable();
  await draft.fill("检查页面\n保留这份草稿");
  await draft.selectText();
  await draft.fill("修改后的新任务草稿");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByLabel("发送给 Codex")).toHaveValue("修改后的新任务草稿");
  await expect(page.getByRole("heading", { name: "有什么需要帮忙？" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("发送给 Codex")).toHaveValue("修改后的新任务草稿");
});

test("returning to projects clears keyboard offset before delayed viewport events", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("发送给 Codex").fill("保留草稿");
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, get: () => 500 });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 280 });
    viewport.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".remote-page")).toHaveCSS("top", "280px");
  await page.getByRole("button", { name: "返回任务", exact: true }).click();
  await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
  await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("resize")));
  await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
  await expect(page.getByRole("heading", { name: "远程", exact: true })).toBeInViewport();
});

for (const screen of ["projects", "conversation"]) {
  test(`${screen} keeps input visible when keyboard resize leaves a stale pan`, async ({
    page,
  }, testInfo) => {
    await page.goto("/?remote=1");
    if (screen === "conversation") {
      await page.getByRole("button", { name: "新建 Codex 任务" }).click();
      await page.getByRole("button", { name: "创建", exact: true }).click();
    }
    const input =
      screen === "conversation"
        ? page.getByLabel("发送给 Codex")
        : page.locator(".remote-search input");
    await input.fill("键盘布局回归");
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "offsetTop", {
        configurable: true,
        get: () => 320,
      });
    });
    await page.setViewportSize({ width: 390, height: 430 });
    await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
    await expect(page.locator(".remote-page")).toHaveCSS("height", "430px");
    await expect(input).toBeInViewport();
    await expect(input).toHaveValue("键盘布局回归");
    const header = await page.locator(".remote-header").boundingBox();
    expect(header!.y).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`${screen}-keyboard.png`) });
    await input.evaluate((element) => element.blur());
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
    await expect
      .poll(async () => Math.abs((await page.locator(".remote-page").boundingBox())!.height - 844))
      .toBeLessThan(1);
    await input.focus();
    await expect
      .poll(async () => Math.abs((await page.locator(".remote-page").boundingBox())!.y))
      .toBeLessThan(1);
  });
}

for (const screen of ["projects", "conversation"]) {
  test(`${screen} stays anchored throughout the Feishu keyboard opening and closing animation`, async ({
    page,
  }) => {
    await page.goto("/?remote=1");
    if (screen === "conversation") {
      await page.getByRole("button", { name: "新建 Codex 任务" }).click();
      await page.getByRole("button", { name: "创建", exact: true }).click();
    }
    await page.evaluate(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Lark/7.50.0",
      });
    });
    const input =
      screen === "conversation"
        ? page.getByLabel("发送给 Codex")
        : page.locator(".remote-search input");
    await input.fill("保留输入");
    // Native viewport events precede layout resize. Check every painted frame,
    // including the period when the old full-height container is still present.
    for (const [height, offset] of [
      [740, 104],
      [600, 244],
      [430, 320],
      [430, 0],
      [600, 244],
      [740, 104],
      [844, 0],
    ]) {
      const frame = await page.evaluate(
        async ({ height, offset }) => {
          const viewport = window.visualViewport!;
          Object.defineProperty(viewport, "height", { configurable: true, get: () => height });
          Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => offset });
          viewport.dispatchEvent(new Event("resize"));
          viewport.dispatchEvent(new Event("scroll"));
          await new Promise(requestAnimationFrame);
          const header = document.querySelector(".remote-header")!.getBoundingClientRect();
          const pageBounds = document.querySelector(".remote-page")!.getBoundingClientRect();
          return { top: header.top, bottom: pageBounds.bottom };
        },
        { height: height!, offset: offset! },
      );
      expect(Math.abs(frame.top)).toBeLessThan(1);
      expect(frame.bottom).toBeLessThanOrEqual(height! + 1);
    }
    await expect(input).toHaveValue("保留输入");
    await expect(input).toBeFocused();
  });
}

for (const screen of ["projects", "conversation"]) {
  test(`${screen} intercepts the first iOS Feishu input tap before native reveal scrolling`, async ({
    page,
  }) => {
    await page.goto("/?remote=1");
    if (screen === "conversation") {
      await page.getByRole("button", { name: "新建 Codex 任务" }).click();
      await page.getByRole("button", { name: "创建", exact: true }).click();
    }
    const input =
      screen === "conversation"
        ? page.getByLabel("发送给 Codex")
        : page.locator(".remote-search input");
    await input.evaluate((element) => element.blur());
    await page.evaluate(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Lark/7.50.0",
      });
      document.addEventListener("touchend", (event) => {
        document.documentElement.dataset.tapPrevented = String(event.defaultPrevented);
      });
      document.querySelector(".remote-page")!.addEventListener("focusin", (event) => {
        document.documentElement.dataset.focusOpacity = getComputedStyle(
          event.target as Element,
        ).opacity;
      });
    });
    await input.tap();
    await expect(input).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "true");
    await expect(page.locator("html")).toHaveAttribute("data-focus-opacity", "0");
    await expect(input).toHaveCSS("opacity", "1");
    await input.fill("保留草稿和光标");
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 500 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    // Let the modeled keyboard finish its opening animation before caret taps.
    await page.waitForTimeout(260);
    await input.tap();
    await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "false");
    await expect(input).toHaveValue("保留草稿和光标");
    await expect(input).toBeFocused();
    // Repeat Done/reopen with both possible WebKit behaviors: DOM focus is
    // retained, or actually blurred. Do not wait for closing animations.
    for (let cycle = 0; cycle < 12; cycle++) {
      await input.evaluate(
        (element, blur) => {
          (element as HTMLInputElement).setSelectionRange(2, 4);
          if (blur) element.blur();
          Object.defineProperty(window.visualViewport!, "height", {
            configurable: true,
            value: 844,
          });
          window.visualViewport!.dispatchEvent(new Event("resize"));
        },
        cycle % 2 === 1,
      );
      await input.tap();
      await expect(input).toBeFocused();
      await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "true");
      await expect(input).toHaveCSS("opacity", "1");
      await expect(input).toHaveValue("保留草稿和光标");
      expect(
        await input.evaluate((element) => [
          (element as HTMLInputElement).selectionStart,
          (element as HTMLInputElement).selectionEnd,
        ]),
      ).toEqual([2, 4]);
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 500 });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
    }
    await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
  });
}

test("project search icon and label padding use protected focus too", async ({ page }) => {
  await page.goto("/?remote=1");
  await expect(page.locator(".remote-search input")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Lark/7.50.0",
    });
    document.addEventListener("touchend", (event) => {
      document.documentElement.dataset.tapPrevented = String(event.defaultPrevented);
    });
    document.querySelector(".remote-page")!.addEventListener("focusin", (event) => {
      document.documentElement.dataset.focusOpacity = getComputedStyle(
        event.target as Element,
      ).opacity;
    });
  });
  const input = page.getByRole("searchbox", { name: "搜索 Codex 任务" });
  for (let cycle = 0; cycle < 8; cycle++) {
    await input.evaluate((element) => element.blur());
    if (cycle % 2) await page.locator(".remote-search .sf-symbol").tap();
    else await page.locator(".remote-search").tap({ position: { x: 5, y: 25 } });
    await expect(input).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "true");
    await expect(page.locator("html")).toHaveAttribute("data-focus-opacity", "0");
    await expect(input).toHaveCSS("opacity", "1");
  }
});

test("keyboard diagnostics are opt-in and save geometry without draft contents", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await expect(page.getByRole("button", { name: "保存键盘诊断" })).toHaveCount(0);
  await page.goto("/?remote=1&keyboardDebug=1");
  await page.getByRole("searchbox", { name: "搜索 Codex 任务" }).fill("DO_NOT_COLLECT_DRAFT");
  let uploaded = "";
  await page.route("**/api/v1/remote/uploads", async (route) => {
    const body = route.request().postDataJSON();
    uploaded = Buffer.from(body.base64, "base64").toString();
    await route.fulfill({
      json: {
        data: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "keyboard-diagnostics.json",
          mimeType: "application/json",
          size: Buffer.byteLength(uploaded),
        },
      },
    });
  });
  await page.getByRole("button", { name: "保存键盘诊断" }).click();
  await expect(page.getByRole("button", { name: "诊断已保存" })).toBeVisible();
  expect(uploaded).not.toContain("DO_NOT_COLLECT_DRAFT");
  expect(JSON.parse(uploaded).records.length).toBeGreaterThan(0);
  expect(JSON.parse(uploaded).records.length).toBeLessThanOrEqual(300);
});
