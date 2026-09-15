import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`CodexBoard Web 登录品牌和图标在 ${width}px 正常显示`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/v1/auth/config", (route) =>
      route.fulfill({
        json: { data: { authMode: "web", feishuAppId: null, webLoginEnabled: true } },
      }),
    );
    await page.route("**/api/v1/session", (route) => route.fulfill({ status: 401, json: {} }));
    await page.goto("/");
    await expect(page).toHaveTitle("CodexBoard");
    await expect(page.getByRole("heading", { name: "登录 CodexBoard" })).toBeVisible();
    const logo = page.getByRole("img", { name: "CodexBoard" });
    await expect(logo).toBeVisible();
    expect(
      await logo.evaluate(
        (element: HTMLImageElement) => element.complete && element.naturalWidth === 256,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const icon = page.locator('link[rel="icon"]');
    const response = await page.request.get((await icon.getAttribute("href"))!);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
    await page.screenshot({
      path: test.info().outputPath(`codexboard-login-${width}.png`),
      fullPage: true,
    });
  });
}
