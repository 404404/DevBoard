import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, webkit } from "playwright";

const ui = new URL("../ui/", import.meta.url);
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: desktop text remains selected through snapshot refreshes`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.setContent(
        readFileSync(new URL("index.html", ui), "utf8").replace(
          /<script[^>]*src="app.js"[^>]*><\/script>/,
          "",
        ),
      );
      await page.addStyleTag({ content: readFileSync(new URL("style.css", ui), "utf8") });
      await page.evaluate(() => {
        window.testState = {
          phase: "ready",
          message: "运行正常，可以打开看板",
          configRevision: 0,
          ports: { api: 47823, admin: 47824, bridge: 47825, caddy: 8443 },
          deployment: {
            appId: "cli_test",
            appSecret: "test",
            frpc: "serverPort = 7000",
            paths: { credentials: "/test/credentials.json", frpc: "/test/frpc.toml" },
          },
          settings: { configDirectory: "/test/config", codexPath: "/test/bin/codex" },
          services: [{ name: "DevBoard 后端", status: "ready" }],
          logs: [{ time: "12:00", component: "Caddy", message: "服务已启动" }],
          setup: {
            context: { origin: "https://example.test", domain: "example.test" },
            results: [
              {
                section: "feishu",
                title: "凭据检查",
                status: "passed",
                message: "配置检查通过",
                details: ["应用可以访问"],
              },
            ],
          },
        };
        window.__TAURI__ = { core: { invoke: async () => window.testState } };
        // Drive the real poll without starting services or waiting on network requests.
        window.setTimeout = (callback) => {
          window.nextPoll = callback;
        };
      });
      await page.addScriptTag({ content: readFileSync(new URL("app.js", ui), "utf8") });
      await page.waitForFunction(() => Boolean(window.nextPoll));
      for (const [tab, selector] of [
        ["overview", "#services"],
        ["overview", "#message"],
        ["guide", "#setup-origin"],
        ["guide", "#setup-results-feishu"],
        ["guide", "#setup-step-feishu .setup-help:first-of-type"],
        ["connections", "#frpc-hint"],
        ["logs", "#log-list"],
      ]) {
        await page.locator(`[data-tab="${tab}"]`).click();
        await page.locator(selector).evaluate((element) => {
          const details = element.closest("details");
          if (details) details.open = true;
        });
        const selected = await page.locator(selector).evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          return window.getSelection().toString();
        });
        assert.ok(selected.length, selector);
        await page.evaluate(async () => {
          await window.nextPoll();
          await window.nextPoll();
        });
        assert.equal(
          await page.evaluate(() => window.getSelection().toString()),
          selected,
          selector,
        );
      }
      // A new log must not destroy the selected older log; catch up after deselection.
      await page.evaluate(async () => {
        window.testState.logs.push({ time: "12:01", component: "Caddy", message: "新日志" });
        window.testState.message = "新的状态";
        await window.nextPoll();
      });
      assert.match(await page.evaluate(() => window.getSelection().toString()), /服务已启动/);
      assert.equal(await page.locator("#message").textContent(), "新的状态");
      await page.evaluate(async () => {
        window.getSelection().removeAllRanges();
        await window.nextPoll();
      });
      assert.match(await page.locator("#log-list").textContent(), /新日志/);
      // A range spanning sibling sections must survive actual updates to both.
      await page.locator('[data-tab="overview"]').click();
      const spanning = await page.evaluate(() => {
        const range = document.createRange();
        range.setStart(document.querySelector("#message").firstChild, 0);
        range.setEndAfter(document.querySelector("#services"));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        return window.getSelection().toString();
      });
      await page.evaluate(async () => {
        window.testState.message = "更新后的状态";
        window.testState.services[0].status = "stopped";
        await window.nextPoll();
      });
      assert.equal(await page.evaluate(() => window.getSelection().toString()), spanning);
      await page.evaluate(async () => {
        window.getSelection().removeAllRanges();
        await window.nextPoll();
      });
      assert.equal(await page.locator("#message").textContent(), "更新后的状态");
      assert.equal(await page.locator("#services small").first().textContent(), "未运行");
      for (const [tab, id] of [
        ["settings", "directory"],
        ["settings", "codex"],
        ["connections", "app-id"],
        ["connections", "frpc-content"],
      ]) {
        await page.locator(`[data-tab="${tab}"]`).click();
        await page.locator(`#${id}`).evaluate((input) => {
          input.focus();
          input.select();
        });
        const readSelection = () =>
          page
            .locator(`#${id}`)
            .evaluate((input) => [input.selectionStart, input.selectionEnd, input.value]);
        const before = await readSelection();
        await page.evaluate(() => window.nextPoll());
        assert.deepEqual(await readSelection(), before, id);
      }
      // Real mouse drag, including a refresh while the mouse is held down.
      await page.locator('[data-tab="overview"]').click();
      const label = page.locator("#services .service span").first();
      const box = await label.boundingBox();
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
      const dragged = await page.evaluate(() => window.getSelection().toString());
      assert.ok(dragged.includes("DevBoard"));
      await page.evaluate(() => window.nextPoll());
      await page.mouse.up();
      await page.evaluate(() => window.nextPoll());
      assert.equal(await page.evaluate(() => window.getSelection().toString()), dragged);
    } finally {
      await browser.close();
    }
  });
}
