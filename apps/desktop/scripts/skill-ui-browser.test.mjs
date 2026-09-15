import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium, webkit } from "playwright";

const ui = new URL("../ui/", import.meta.url);

async function fixture(browser, state = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 730 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    readFileSync(new URL("index.html", ui), "utf8").replace(/<script[^>]*><\/script>/g, ""),
  );
  await page.addStyleTag({ content: readFileSync(new URL("style.css", ui), "utf8") });
  await page.evaluate((initial) => {
    window.skillCalls = [];
    window.skillTestState = {
      bundledVersion: "0.1.1",
      installedVersion: null,
      offerDismissed: false,
      status: "notInstalled",
      targetPath: "/Users/example/.agents/skills/manage-codexboard",
      fingerprint: "original",
      message: "",
      canInstall: true,
      canReplace: false,
      ...initial,
    };
    window.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          if (command === "snapshot")
            return {
              phase: "stopped",
              ports: { api: 58978, admin: 58979, bridge: 58980, caddy: 58981 },
              services: [],
              logs: [],
            };
          if (command === "skill_status") {
            if (window.deferSkillRead)
              return new Promise((resolve) => {
                window.deferredSkillReads.push(resolve);
              });
            if (window.failSkillRead) throw new Error("Synthetic status read failure");
            return structuredClone(window.skillTestState);
          }
          window.skillCalls.push({ command, args });
          if (command === "dismiss_skill_offer") window.skillTestState.offerDismissed = true;
          if (command === "install_skill") {
            if (args.expectedFingerprint !== window.skillTestState.fingerprint)
              throw new Error("内容已变化");
            window.skillTestState = {
              ...window.skillTestState,
              status: "current",
              fingerprint: "installed",
              installedVersion: "0.1.1",
              offerDismissed: true,
              canInstall: false,
              canReplace: false,
            };
          }
          return structuredClone(window.skillTestState);
        },
      },
    };
  }, state);
  await page.addScriptTag({ content: readFileSync(new URL("app.js", ui), "utf8") });
  await page.addScriptTag({ content: readFileSync(new URL("skills.js", ui), "utf8") });
  return { page, errors };
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: first-launch offer waits for consent and settings retain install/update controls`, async () => {
    const browser = await engine.launch();
    try {
      const { page, errors } = await fixture(browser);
      await page.locator("#skill-offer-dialog").waitFor({ state: "visible" });
      if (process.env.CODEXBOARD_SKILL_UI_ARTIFACT_DIR)
        await page.screenshot({
          path: `${process.env.CODEXBOARD_SKILL_UI_ARTIFACT_DIR}/${name}-offer.png`,
        });
      assert.deepEqual(await page.evaluate(() => window.skillCalls), []);
      assert.equal(await page.evaluate(() => document.activeElement.id), "skill-offer-later");
      await page.locator("#skill-offer-later").click();
      assert.equal(await page.locator("#skill-offer-dialog").isVisible(), false);
      await page.locator('[data-tab="settings"]').click();
      if (process.env.CODEXBOARD_SKILL_UI_ARTIFACT_DIR)
        await page.screenshot({
          path: `${process.env.CODEXBOARD_SKILL_UI_ARTIFACT_DIR}/${name}-settings.png`,
        });
      await page.locator("#skill-install").click();
      await page.waitForFunction(() =>
        document.getElementById("skill-status").textContent.includes("文件已安装"),
      );
      assert.deepEqual(await page.evaluate(() => window.skillCalls), [
        { command: "dismiss_skill_offer", args: undefined },
        {
          command: "install_skill",
          args: { expectedFingerprint: "original", replaceModified: false },
        },
      ]);
      await page.evaluate(() => {
        Object.assign(window.skillTestState, {
          status: "updateAvailable",
          bundledVersion: "0.1.2",
          fingerprint: "update",
          canInstall: true,
        });
      });
      await page.locator("#skill-refresh").click();
      await page.locator("#skill-notice").waitFor({ state: "visible" });
      assert.equal(await page.locator("#skill-install").textContent(), "更新 Skill");
      assert.equal((await page.evaluate(() => window.skillCalls)).length, 2);
      assert.equal(await page.locator("#skill-offer-dialog").isVisible(), false);
      await page.evaluate(() => {
        window.codexBoardAppUpdateInstalling = true;
      });
      await page.locator("#skill-refresh").click();
      await page.waitForFunction(() => document.getElementById("skill-install").disabled);
      const card = await page.locator("#skill-card").boundingBox();
      assert.ok(card.x >= 0 && card.x + card.width <= 1000);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  test(`${name}: replacement needs explicit consent for unchanged content and failed reads disable writes`, async () => {
    const browser = await engine.launch();
    try {
      const { page, errors } = await fixture(browser, {
        status: "modified",
        canInstall: false,
        canReplace: true,
        offerDismissed: true,
      });
      await page.locator('[data-tab="settings"]').click();
      await page.locator("#skill-replace").click();
      await page.locator("#skill-replace-dialog").waitFor({ state: "visible" });
      if (process.env.CODEXBOARD_SKILL_UI_ARTIFACT_DIR) {
        await page.setViewportSize({ width: 780, height: 580 });
        await page.screenshot({
          path: `${process.env.CODEXBOARD_SKILL_UI_ARTIFACT_DIR}/${name}-replace.png`,
        });
      }
      assert.deepEqual(await page.evaluate(() => window.skillCalls), []);
      await page.evaluate(() => {
        window.skillTestState.fingerprint = "new-external-edit";
        document.getElementById("skill-refresh").click();
      });
      await page.waitForFunction(() => document.getElementById("skill-replace-confirm").disabled);
      assert.match(await page.locator("#skill-replace-error").textContent(), /内容已变化/);
      await page.locator("#skill-replace-cancel").click();
      await page.evaluate(() => {
        window.failSkillRead = true;
      });
      await page.locator("#skill-refresh").click();
      await page.locator("#skill-error").waitFor({ state: "visible" });
      assert.equal(await page.locator("#skill-replace").isDisabled(), true);
      await page.evaluate(() => {
        window.failSkillRead = false;
      });
      await page.locator("#skill-refresh").click();
      await page.waitForFunction(() => !document.getElementById("skill-replace").disabled);
      await page.locator("#skill-replace").click();
      await page.locator("#skill-replace-confirm").click();
      await page.waitForFunction(() =>
        document.getElementById("skill-status").textContent.includes("文件已安装"),
      );
      assert.deepEqual(await page.evaluate(() => window.skillCalls), [
        {
          command: "install_skill",
          args: { expectedFingerprint: "new-external-edit", replaceModified: true },
        },
      ]);
      await page.evaluate(() => {
        Object.assign(window.skillTestState, {
          status: "managed",
          canInstall: false,
          canReplace: false,
        });
      });
      await page.locator("#skill-refresh").click();
      await page.waitForFunction(() =>
        document.getElementById("skill-status").textContent.includes("其他方式管理"),
      );
      assert.equal(await page.locator("#skill-install").isVisible(), false);
      assert.equal(await page.locator("#skill-replace").isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  test(`${name}: a late status reply cannot restore stale installation permissions`, async () => {
    const browser = await engine.launch();
    try {
      const { page } = await fixture(browser, { offerDismissed: true });
      await page.locator('[data-tab="settings"]').click();
      await page.evaluate(() => {
        window.deferSkillRead = true;
        window.deferredSkillReads = [];
        document.getElementById("skill-refresh").click();
        document.getElementById("skill-refresh").click();
      });
      await page.waitForFunction(() => window.deferredSkillReads.length === 2);
      await page.evaluate(() =>
        window.deferredSkillReads[1]({
          ...window.skillTestState,
          status: "managed",
          canInstall: false,
          canReplace: false,
        }),
      );
      await page.waitForFunction(() =>
        document.getElementById("skill-status").textContent.includes("其他方式管理"),
      );
      await page.evaluate(async () => {
        window.deferredSkillReads[0](window.skillTestState);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(await page.locator("#skill-install").isVisible(), false);
      assert.deepEqual(await page.evaluate(() => window.skillCalls), []);
    } finally {
      await browser.close();
    }
  });
}
