import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium, webkit } from "playwright";
const ui = new URL("../ui/", import.meta.url);
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: guide switches Web and Feishu flows without hiding or changing connection methods`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(
        readFileSync(new URL("index.html", ui), "utf8").replace(/<script[^>]*><\/script>/g, ""),
      );
      await page.addStyleTag({ content: readFileSync(new URL("style.css", ui), "utf8") });
      await page.evaluate(() => {
        window.calls = [];
        window.setupResult = {};
        window.__TAURI__ = {
          core: {
            invoke: async (name, args) => {
              if (name === "snapshot")
                return {
                  setup: window.setupResult,
                  phase: "stopped",
                  services: [],
                  logs: [],
                  deployment: {
                    accessMode: "feishu",
                    appId: "",
                    appSecret: "",
                    frpc: "example tunnel",
                  },
                };
              if (args?.action === "setup_check")
                window.setupResult = {
                  requestKey: args.settings.requestKey,
                  checkedAt: "2026-09-15",
                  results: [],
                };
              window.calls.push({ name, args });
            },
          },
        };
      });
      await page.addScriptTag({ content: readFileSync(new URL("app.js", ui), "utf8") });
      await page.locator('[data-tab="guide"]').click();
      await page.locator("#setup-access-mode").selectOption("web");
      assert.equal(await page.locator("#setup-step-feishu").isVisible(), false);
      assert.equal(await page.locator("#setup-step-web").isVisible(), true);
      assert.equal(await page.locator("#setup-step-codex").isVisible(), true);
      await page.locator("#setup-check-all").click();
      assert.equal(
        (await page.evaluate(() => window.calls.at(-1))).args.settings.accessMode,
        "web",
      );
      await page.locator("#setup-save").click();
      assert.equal(await page.locator("#access-mode").count(), 0);
      assert.equal(await page.locator("#app-id").isVisible(), true);
      assert.equal(await page.locator("#app-id").getAttribute("required"), null);
      await page.locator("#app-id").fill("cli_both");
      await page.locator("#app-secret").fill("test-secret");
      await page.locator("#save-connections").click();
      const saved = (await page.evaluate(() => window.calls.at(-1))).args.settings;
      assert.equal(saved.accessMode, undefined);
      assert.equal(saved.appId, "cli_both");
      assert.equal(saved.appSecret, "test-secret");
      assert.equal(await page.locator("#connections-web-accounts").isVisible(), true);
      await page.locator('[data-tab="guide"]').click();
      await page.locator("#setup-open-board").click();
      assert.equal((await page.evaluate(() => window.calls.at(-1))).args.action, "open_web_board");
      await page.locator("#setup-access-mode").selectOption("feishu");
      assert.equal(await page.locator("#setup-step-feishu").isVisible(), true);
      assert.equal(await page.locator("#setup-step-web").isVisible(), false);
      await page.locator("#setup-open-board").click();
      assert.equal((await page.evaluate(() => window.calls.at(-1))).name, "open_board");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
