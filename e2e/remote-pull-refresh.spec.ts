import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function touch(page: Page, type: string, y: number, x = 100, count = 1) {
  await page.locator(".remote-list-body").evaluate(
    (element, args) => {
      const touches =
        args.type === "touchend" || args.type === "touchcancel"
          ? []
          : Array.from({ length: args.count }, (_, identifier) => ({
              identifier,
              target: element,
              clientX: args.x + identifier * 20,
              clientY: args.y,
            }));
      const event = new Event(args.type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      element.dispatchEvent(event);
    },
    { type, y, x, count },
  );
}

test("pull refresh updates projects and tasks, preserves expansion, and waits for both requests", async ({
  page,
}) => {
  let calls = 0;
  let projectCalls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/projects", async (route) => {
    projectCalls++;
    if (projectCalls > 1) await pending;
    await route.continue();
  });
  await page.route("**/api/v1/remote/threads?*", (route) =>
    route.fulfill({
      json: {
        data: {
          nextCursor: null,
          threads: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              title: ++calls === 1 ? "刷新前" : "刷新后",
              preview: "",
              cwd: "/unassigned",
              updatedAt: 1,
              status: "idle",
            },
          ],
        },
      },
    }),
  );
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "最近", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新前", exact: true })).toBeVisible();
  try {
    await touch(page, "touchstart", 150);
    await touch(page, "touchmove", 190);
    await expect(page.getByText("下拉刷新", { exact: true })).toBeVisible();
    await touch(page, "touchmove", 310);
    await expect(page.getByText("松开刷新", { exact: true })).toBeVisible();
    await touch(page, "touchend", 310);
    await expect(page.getByText("刷新中…", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新后", exact: true })).toBeVisible();
    await touch(page, "touchstart", 150);
    await touch(page, "touchmove", 310);
    await touch(page, "touchend", 310);
    expect(calls).toBe(2);
    expect(projectCalls).toBe(2);
  } finally {
    release();
  }
  await expect(page.getByText("刷新中…", { exact: true })).toHaveCount(0);
});

test("short, horizontal, multi-touch and canceled pulls do not refresh", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/v1/remote/threads?*", (route) => {
    calls++;
    return route.fulfill({ json: { data: { threads: [], nextCursor: null } } });
  });
  await page.goto("/?remote=1");
  await expect(page.getByRole("button", { name: "最近", exact: true })).toBeVisible();
  for (const [x, y, count, end] of [
    [100, 180, 1, "touchend"],
    [300, 310, 1, "touchend"],
    [100, 310, 2, "touchend"],
    [100, 310, 1, "touchcancel"],
  ] as const) {
    await touch(page, "touchstart", 150);
    await touch(page, "touchmove", y, x, count);
    await touch(page, end, y);
  }
  expect(calls).toBe(1);
  await expect(page.getByText("刷新中…", { exact: true })).toHaveCount(0);
});

test("scrolling down the list cannot arm refresh even when the same gesture reaches the top", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/v1/remote/threads?*", (route) => {
    calls++;
    return route.fulfill({
      json: {
        data: {
          nextCursor: null,
          threads: Array.from({ length: 40 }, (_, i) => ({
            id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
            title: `任务 ${i}`,
            preview: "",
            cwd: "/unassigned",
            updatedAt: i,
            status: "idle",
          })),
        },
      },
    });
  });
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "最近", exact: true }).click();
  const body = page.locator(".remote-list-body");
  await body.evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await touch(page, "touchstart", 150);
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await touch(page, "touchmove", 350);
  await touch(page, "touchend", 350);
  expect(calls).toBe(1);
  await expect(page.getByText("刷新中…", { exact: true })).toHaveCount(0);
});

test("failed refresh ends loading and a new pull can recover", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/v1/remote/threads?*", (route) => {
    calls++;
    return calls === 2
      ? route.fulfill({
          status: 503,
          json: { error: { code: "UPSTREAM_ERROR", message: "测试断线" } },
        })
      : route.fulfill({ json: { data: { threads: [], nextCursor: null } } });
  });
  await page.goto("/?remote=1");
  await expect(page.getByRole("button", { name: "最近", exact: true })).toBeVisible();
  for (const expected of [2, 3]) {
    await touch(page, "touchstart", 150);
    await touch(page, "touchmove", 310);
    await touch(page, "touchend", 310);
    await expect.poll(() => calls).toBe(expected);
    await expect(page.locator(".remote-list-body")).toHaveAttribute("aria-busy", "false");
  }
  await expect(page.getByRole("button", { name: "最近", exact: true })).toBeVisible();
});

test("native touch scrolling and pull refresh coexist", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP native touch injection is Chromium-only");
  let calls = 0;
  await page.route("**/api/v1/remote/threads?*", (route) => {
    calls++;
    return route.fulfill({
      json: {
        data: {
          nextCursor: null,
          threads: Array.from({ length: 40 }, (_, i) => ({
            id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
            title: `任务 ${i}`,
            preview: "",
            cwd: "/unassigned",
            updatedAt: i,
            status: "idle",
          })),
        },
      },
    });
  });
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "最近", exact: true }).click();
  const body = page.locator(".remote-list-body");
  const box = (await body.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (from: number, to: number) => {
    const x = box.x + box.width - 8;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: from }],
    });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: from + ((to - from) * i) / 8 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(box.y + 80, box.y + 260);
  await expect.poll(() => calls).toBe(2);
  await expect(body).toHaveAttribute("aria-busy", "false");
  await swipe(box.y + 300, box.y + 80);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(calls).toBe(2);
});
