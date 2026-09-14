import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../ui/updater.js", import.meta.url), "utf8");
const day = 24 * 60 * 60 * 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function updater(initial = {}, options = {}) {
  let now = 1_800_000_000_000;
  let native = {
    currentVersion: "0.1.0",
    status: "idle",
    version: null,
    notes: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    lastChecked: now,
    canInstall: false,
    ...initial,
  };
  const elements = new Map();
  const calls = [];
  const timers = new Map();
  const listeners = new Map();
  const dirty = new Set();
  let timerId = 0;
  let failRead = false;
  let selectedSettings = false;
  const get = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: "",
        hidden: false,
        disabled: false,
        open: false,
        value: undefined,
        removeAttribute(name) {
          delete this[name];
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
        focus() {
          this.focused = true;
        },
        scrollIntoView() {
          this.scrolled = true;
        },
      });
    return elements.get(id);
  };
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const context = {
    window: options.preview
      ? {}
      : {
          __TAURI__: {
            core: {
              invoke: async (command, args) => {
                calls.push({ command, args: args ? JSON.parse(JSON.stringify(args)) : undefined });
                if (command === "update_status") {
                  if (failRead) throw new Error("status unavailable");
                  return { ...native };
                }
                const result = await options.command?.(command, args);
                if (result) native = { ...native, ...result };
                else if (command === "check_updates")
                  native = { ...native, status: "upToDate", lastChecked: now };
                else if (command === "download_update")
                  native = { ...native, status: "downloading" };
                else if (command === "install_update") native = { ...native, status: "installing" };
                return { ...native };
              },
            },
          },
        },
    document: {
      getElementById: get,
      querySelector: () => ({ click: () => (selectedSettings = true) }),
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    dirtyFields: dirty,
    pending: false,
    snapshot: {},
    Date: Clock,
    setTimeout: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(script, context);
  await flush();
  return {
    get,
    calls,
    dirty,
    selectedSettings: () => selectedSettings,
    input: () => listeners.get("input")(),
    failRead: (value) => (failRead = value),
    async poll(update = {}, elapsed = 0) {
      native = { ...native, ...update };
      now += elapsed;
      const [id, fn] = timers.entries().next().value;
      timers.delete(id);
      await fn();
      await flush();
    },
  };
}

test("daily automatic checks respect persisted lastChecked and manual checks bypass that schedule", async () => {
  const ui = await updater({ lastChecked: null });
  assert.deepEqual(
    ui.calls.filter((call) => call.command === "check_updates"),
    [{ command: "check_updates", args: { automatic: true } }],
  );
  await ui.poll({}, day - 1);
  assert.equal(ui.calls.filter((call) => call.command === "check_updates").length, 1);
  await ui.poll({}, 1);
  assert.equal(ui.calls.filter((call) => call.command === "check_updates").length, 2);
  await ui.get("update-check").onclick();
  assert.deepEqual(ui.calls.at(-1), { command: "check_updates", args: { automatic: false } });
  const recentlyChecked = await updater({ status: "upToDate" });
  assert.equal(recentlyChecked.calls.length, 1);
  assert.match(recentlyChecked.get("update-current-version").textContent, /0\.1\.0/);
});

test("updates notify without opening dialogs, keep dismissal during polling, and navigate only on click", async () => {
  const ui = await updater({ status: "available", version: "0.2.0" });
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.get("update-notice").hidden, false);
  assert.equal(ui.get("update-dialog").open, false);
  assert.equal(ui.selectedSettings(), false);
  ui.get("update-notice-dismiss").onclick();
  await ui.poll();
  assert.equal(ui.get("update-notice").hidden, true);
  ui.get("update-notice-open").onclick();
  assert.equal(ui.selectedSettings(), true);
  assert.equal(ui.get("update-card").scrolled, true);
  await ui.get("update-download").onclick();
  assert.equal(ui.calls.at(-1).command, "download_update");
  await ui.poll({ status: "ready", canInstall: true });
  assert.equal(ui.get("update-notice").hidden, false);
  assert.equal(ui.get("update-dialog").open, false);
  assert.equal(
    ui.calls.some((call) => call.command === "install_update"),
    false,
  );
});

test("an ignored available version is checked again daily without interrupting a downloaded update", async () => {
  const ui = await updater(
    { status: "available", version: "0.2.0" },
    {
      command: async () => ({ status: "available", version: "0.3.0" }),
    },
  );
  ui.get("update-notice-dismiss").onclick();
  await ui.poll({}, day - 1);
  assert.equal(ui.calls.filter((call) => call.command === "check_updates").length, 0);
  await ui.poll({}, 1);
  assert.deepEqual(
    ui.calls.filter((call) => call.command === "check_updates"),
    [{ command: "check_updates", args: { automatic: true } }],
  );
  assert.match(ui.get("update-notice-text").textContent, /0\.3\.0/);
  assert.equal(ui.get("update-notice").hidden, false);
  for (const status of ["downloading", "ready", "installing"])
    await ui.poll({ status, canInstall: status !== "downloading", lastChecked: null }, day);
  assert.equal(ui.calls.filter((call) => call.command === "check_updates").length, 1);
});

test("clock rollback does not leave persisted or in-memory automatic-check timestamps stuck in the future", async () => {
  const ui = await updater({ lastChecked: null });
  assert.equal(ui.calls.filter((call) => call.command === "check_updates").length, 1);
  await ui.poll({}, -day);
  assert.equal(ui.calls.filter((call) => call.command === "check_updates").length, 2);
  await ui.poll();
  assert.equal(ui.calls.filter((call) => call.command === "check_updates").length, 2);
});

test("download progress handles missing totals and release notes stay plain text", async () => {
  const notes = '<img src="x" onerror="alert(1)">\n[link](https://example.com)';
  const ui = await updater({
    status: "downloading",
    version: "0.2.0",
    notes,
    downloadedBytes: 1024,
  });
  assert.equal(ui.get("update-download-progress").hidden, false);
  assert.equal(ui.get("update-progress").value, undefined);
  assert.match(ui.get("update-progress-text").textContent, /1 KB/);
  assert.equal(ui.get("update-notes").textContent, notes);
  assert.equal(ui.get("update-notes").innerHTML, undefined);
  assert.equal(ui.get("update-check").disabled, true);
  await ui.poll({ totalBytes: 2048 });
  assert.equal(ui.get("update-progress").value, 50);
  await ui.poll({ downloadedBytes: 4096 });
  assert.equal(ui.get("update-progress").value, 100);
});

test("installation requires confirmation, refuses unsaved edits and prevents duplicate installs", async () => {
  const ui = await updater({ status: "ready", version: "0.2.0", canInstall: true });
  await ui.get("update-confirm").onclick();
  assert.equal(ui.calls.length, 1);
  ui.get("update-install").onclick();
  assert.equal(ui.get("update-dialog").open, true);
  assert.equal(ui.calls.length, 1);
  ui.dirty.add("app-id");
  ui.input();
  assert.equal(ui.get("update-confirm").disabled, true);
  await ui.get("update-confirm").onclick();
  assert.equal(ui.calls.length, 1);
  assert.match(ui.get("update-dialog-error").textContent, /未保存/);
  ui.dirty.clear();
  ui.input();
  await ui.get("update-confirm").onclick();
  await ui.get("update-confirm").onclick();
  assert.equal(ui.calls.filter((call) => call.command === "install_update").length, 1);
  assert.equal(ui.get("update-cancel").disabled, true);
  let prevented = false;
  ui.get("update-dialog").oncancel({ preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  ui.get("update-cancel").onclick();
  assert.equal(ui.get("update-dialog").open, true);
});

test("failed downloads can retry, but only a verified retained package enables installation retry", async () => {
  const ui = await updater({ status: "error", version: "0.2.0", error: "下载失败" });
  assert.equal(ui.get("update-install").hidden, true);
  assert.equal(ui.get("update-download").hidden, false);
  assert.equal(ui.get("update-download").textContent, "重新下载");
  await ui.get("update-download").onclick();
  await ui.poll({ status: "ready", error: null, canInstall: true });
  ui.get("update-install").onclick();
  await ui.get("update-confirm").onclick();
  await ui.poll({ status: "error", error: "未能停止服务，请重试", canInstall: true });
  assert.equal(ui.get("update-dialog").open, true);
  assert.equal(ui.get("update-confirm").disabled, false);
  assert.match(ui.get("update-dialog-error").textContent, /停止服务/);
  assert.equal(ui.get("update-download").hidden, true);
  await ui.get("update-confirm").onclick();
  assert.equal(ui.calls.filter((call) => call.command === "install_update").length, 2);
});

test("command errors remain recoverable and transient status failures clear after recovery", async () => {
  let failed = false;
  const ui = await updater(
    {},
    {
      command: async () => {
        if (!failed) {
          failed = true;
          throw new Error("网络连接失败");
        }
      },
    },
  );
  await ui.get("update-check").onclick();
  assert.match(ui.get("update-error").textContent, /网络连接失败/);
  assert.equal(ui.get("update-check").disabled, false);
  await ui.get("update-check").onclick();
  assert.equal(ui.get("update-error").hidden, true);
  ui.failRead(true);
  await ui.poll();
  assert.match(ui.get("update-error").textContent, /无法读取/);
  ui.failRead(false);
  await ui.poll();
  assert.equal(ui.get("update-error").hidden, true);
});

test("browser preview never issues update commands and install confirmation explains service interruption", async () => {
  const ui = await updater({}, { preview: true });
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.get("update-check").disabled, true);
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="update-dialog-description"[\s\S]*?停止[\s\S]*?本机服务/);
  assert.match(html, /原有配置与任务数据会保留/);
  assert.match(html, /<script src="updater\.js"><\/script>/);
});
