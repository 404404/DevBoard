import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";

const ui = new URL("../ui/", import.meta.url);
for (const [name, engine] of Object.entries({ chromium, webkit }))
  test(`${name}: update notification, settings card and explicit install confirmation work together`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 730 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(
        readFileSync(new URL("index.html", ui), "utf8").replace(/<script[^>]*><\/script>/g, ""),
      );
      await page.addStyleTag({ content: readFileSync(new URL("style.css", ui), "utf8") });
      await page.evaluate(() => {
        window.updateCalls = [];
        let update = {
          currentVersion: "0.1.0",
          status: "available",
          version: "0.2.0",
          notes: "改进更新体验。\n下载完成后，可自行选择安装时间。",
          lastChecked: Date.now(),
          downloadedBytes: 0,
          totalBytes: null,
          error: null,
          canInstall: false,
        };
        window.__TAURI__ = {
          core: {
            invoke: async (command) => {
              if (command === "snapshot")
                return {
                  phase: "ready",
                  ports: { api: 58978, admin: 58979, bridge: 58980, caddy: 58981 },
                  deployment: { appId: "cli_test", appSecret: "test-secret", frpc: "" },
                  services: [],
                  logs: [],
                };
              if (command !== "update_status") window.updateCalls.push(command);
              if (command === "download_update")
                update = { ...update, status: "ready", canInstall: true };
              if (command === "install_update") update = { ...update, status: "installing" };
              return update;
            },
          },
        };
      });
      await page.addScriptTag({ content: readFileSync(new URL("app.js", ui), "utf8") });
      await page.addScriptTag({ content: readFileSync(new URL("updater.js", ui), "utf8") });
      await page.locator("#update-notice").waitFor({ state: "visible" });
      assert.equal(await page.locator("#update-dialog").isVisible(), false);
      assert.equal(await page.locator("#settings").isVisible(), false);
      await page.locator("#update-notice-open").click();
      assert.equal(await page.locator("#settings").isVisible(), true);
      const release = page.locator("#update-release-link");
      assert.equal(
        await release.getAttribute("href"),
        "https://github.com/RocYan98/CodexBoard/releases/latest",
      );
      await release.click();
      assert.equal((await page.evaluate(() => window.updateCalls)).at(-1), "open_release_page");
      await page.evaluate(() => {
        window.updateCalls = [];
      });
      await page.locator("#update-download").click();
      await page.locator("#update-install").waitFor({ state: "visible" });
      assert.deepEqual(await page.evaluate(() => window.updateCalls), ["download_update"]);
      const card = await page.locator("#update-card").boundingBox();
      assert.ok(card.x >= 0 && card.x + card.width <= 1000);
      if (process.env.CODEXBOARD_UPDATER_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.CODEXBOARD_UPDATER_SCREENSHOTS, `updater-${name}.png`),
        });
      await page.locator("#update-install").click();
      assert.equal(await page.locator("#update-dialog").isVisible(), true);
      assert.match(
        await page.locator("#update-dialog-description").textContent(),
        /停止.*本机服务/,
      );
      assert.equal(await page.evaluate(() => document.activeElement.id), "update-cancel");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.id), "update-confirm");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#update-dialog").isVisible(), false);
      assert.deepEqual(await page.evaluate(() => window.updateCalls), ["download_update"]);
      await page.locator("#update-install").click();
      await page.locator("#update-confirm").click();
      assert.deepEqual(await page.evaluate(() => window.updateCalls), [
        "download_update",
        "install_update",
      ]);
      assert.equal(await page.locator("#update-confirm").isDisabled(), true);
      assert.equal(await page.locator("#update-cancel").isDisabled(), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
