import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ports = { api: 47823, admin: 47824, bridge: 47825, caddy: 8443 };
const event = () => ({ preventDefault() {} });
async function editor(initial = {}, onControl = async () => {}) {
  const elements = new Map();
  const element = () => ({
    value: "",
    textContent: "",
    type: "password",
    disabled: false,
    hidden: false,
    open: false,
    dataset: {},
    children: [],
    classList: { toggle() {} },
    addEventListener(name, handler) {
      this[name] = handler;
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    focus() {
      context.document.activeElement = this;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.onclose?.();
    },
    setCustomValidity(message) {
      this.validationMessage = message;
    },
    reportValidity() {
      return !this.validationMessage;
    },
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    const item = elements.get(id);
    item.id = id;
    return item;
  };
  let state = {
    phase: "ready",
    configRevision: 0,
    ports,
    deployment: { appId: "cli_one", appSecret: "secret-one", frpc: "serverPort = 7000" },
    ...initial,
  };
  const tabs = ["overview", "guide", "connections", "ports", "settings", "logs"];
  const navigation = tabs.map((tab) => {
    const item = get(`nav-${tab}`);
    item.dataset.tab = tab;
    item.textContent = tab;
    return item;
  });
  let next;
  const sent = [];
  const copied = [];
  const context = {
    window: {
      __TAURI__: {
        core: {
          invoke: async (name, args) => {
            if (name === "snapshot") return state;
            sent.push(args);
            return onControl(args);
          },
        },
      },
    },
    document: {
      getElementById: get,
      querySelectorAll: (selector) =>
        selector === "[data-tab]" ? navigation : selector === ".page" ? tabs.map(get) : [],
      createElement: element,
      createTextNode: () => ({}),
      activeElement: null,
    },
    setTimeout: (fn) => {
      next = fn;
    },
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
  };
  vm.runInNewContext(readFileSync(new URL("../ui/app.js", import.meta.url), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    get,
    sent,
    copied,
    active: () => context.document.activeElement,
    async snapshot(update) {
      state = { ...state, ...update };
      await next();
    },
  };
}

test("configuration editor synchronizes files without clobbering edits and submits only credentials and frpc", async () => {
  const { get, snapshot, sent } = await editor();
  assert.equal(get("app-secret").value, "secret-one");
  assert.equal(get("frpc-content").value, "serverPort = 7000");
  get("app-id").value = "cli_edit";
  get("app-id").input();
  await snapshot({
    deployment: { appId: "cli_external", appSecret: "secret-one", frpc: "serverPort = 7000" },
  });
  assert.equal(get("app-id").value, "cli_edit");
  await get("connections-form").onsubmit(event());
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), {
    action: "deployment",
    settings: { appId: "cli_edit", appSecret: "secret-one", frpc: "serverPort = 7000" },
  });
  await snapshot({ deploymentRevision: 1, deployment: { appId: "cli_edit" } });
  await snapshot({ deployment: { appId: "cli_external2" } });
  assert.equal(get("app-id").value, "cli_external2");
});

test("new successful save prompts once; later keeps the restart reminder without restarting", async () => {
  const { get, snapshot, sent } = await editor();
  await snapshot({ configRevision: 1, restartRequired: true, deploymentRevision: 1 });
  assert.equal(get("restart-dialog").open, true);
  assert.equal(get("restart-notice").hidden, false);
  get("restart-later").onclick();
  assert.equal(get("restart-dialog").open, false);
  await snapshot({ configRevision: 1 });
  assert.equal(get("restart-dialog").open, false);
  assert.equal(sent.length, 0);
  await get("restart-service").onclick();
  assert.equal(sent[0].action, "restart");
  await snapshot({ restartRequired: false });
  assert.equal(get("restart-notice").hidden, true);
});

test("immediate restart is explicit and failed restart preserves the reminder", async () => {
  const { get, snapshot, sent } = await editor({}, async () => {
    throw new Error("restart failed");
  });
  await snapshot({ configRevision: 1, restartRequired: true });
  await get("restart-now").onclick();
  assert.equal(sent[0].action, "restart");
  assert.match(get("error").textContent, /restart failed/);
  assert.match(get("restart-error").textContent, /restart failed/);
  assert.equal(get("restart-error").hidden, false);
  assert.equal(get("restart-notice").hidden, false);
  assert.equal(get("restart-dialog").open, true);
  assert.equal(get("restart-now").disabled, false);
});

test("immediate restart closes the dialog only after a successful request", async () => {
  const { get, snapshot, sent } = await editor();
  await snapshot({ configRevision: 1, restartRequired: true });
  await get("restart-now").onclick();
  assert.equal(sent[0].action, "restart");
  assert.equal(get("restart-dialog").open, false);
  assert.equal(get("restart-notice").hidden, false);
  await snapshot({ restartRequired: false });
  assert.equal(get("restart-notice").hidden, true);
});

test("edits made after submitting survive the successful save revision", async () => {
  const { get, snapshot } = await editor();
  get("app-id").value = "cli_submitted";
  get("app-id").input();
  await get("connections-form").onsubmit(event());
  get("app-id").value = "cli_newer_edit";
  get("app-id").input();
  await snapshot({ deploymentRevision: 1, deployment: { appId: "cli_submitted" } });
  assert.equal(get("app-id").value, "cli_newer_edit");
});

test("initial saved revision and failed saves never prompt or discard edits", async () => {
  const { get, snapshot } = await editor({ configRevision: 12, restartRequired: true });
  assert.equal(get("restart-dialog").open, false);
  assert.equal(get("restart-notice").hidden, false);
  get("app-id").value = "cli_unsaved";
  get("app-id").input();
  await snapshot({ deploymentSaving: true });
  await snapshot({ deploymentSaving: false, deploymentMessage: "配置无效" });
  assert.equal(get("restart-dialog").open, false);
  assert.equal(get("app-id").value, "cli_unsaved");
  assert.equal(get("connections-result").textContent, "配置无效");
});

test("restart prompt waits for every save to finish", async () => {
  const { get, snapshot } = await editor();
  await snapshot({ configRevision: 1, restartRequired: true, portsSaving: true });
  assert.equal(get("restart-dialog").open, false);
  await snapshot({ portsSaving: false });
  assert.equal(get("restart-dialog").open, true);
});

test("ports editor sends only four local ports and keeps unsaved ports through other form saves", async () => {
  const { get, snapshot, sent } = await editor();
  assert.equal(Number(get("port-api").value), 47823);
  get("port-api").value = "49001";
  get("port-api").input();
  await snapshot({ deploymentRevision: 1, ports: { ...ports, api: 49002 } });
  assert.equal(get("port-api").value, "49001");
  await get("ports-form").onsubmit(event());
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), {
    action: "ports",
    settings: { api: 49001, admin: 47824, bridge: 47825, caddy: 8443 },
  });
  await snapshot({ portsRevision: 1, ports: { ...ports, api: 49001 } });
  await snapshot({ ports: { ...ports, api: 49003 } });
  assert.equal(Number(get("port-api").value), 49003);
});

test("ports reject duplicate local ports and out-of-range or fractional values before saving", async () => {
  const { get, sent } = await editor();
  for (const value of ["47824", "0", "65536", "100.5", ""]) {
    get("port-api").value = value;
    await get("ports-form").onsubmit(event());
    assert.equal(sent.length, 0);
    assert.notEqual(get("ports-result").textContent, "");
  }
  get("port-api").value = "7000";
  await get("ports-form").onsubmit(event());
  assert.equal(sent[0].settings.api, 7000);
});

test("saving ports refreshes clean frpc text without a deployment revision", async () => {
  const { get, snapshot } = await editor();
  get("port-caddy").value = "9443";
  get("port-caddy").input();
  await get("ports-form").onsubmit(event());
  const frpc = "serverPort = 7000\n[[proxies]]\nlocalPort = 9443\n";
  await snapshot({
    configRevision: 1,
    restartRequired: true,
    portsRevision: 1,
    ports: { ...ports, caddy: 9443 },
    deployment: { appId: "cli_one", appSecret: "secret-one", frpc },
  });
  assert.equal(get("frpc-content").value, frpc);
  assert.equal(Number(get("port-caddy").value), 9443);
});

test("ports save never replaces a dirty frpc draft", async () => {
  const { get, snapshot } = await editor();
  get("frpc-content").value = "serverPort = 7000\n# unsaved edit";
  get("frpc-content").input();
  get("port-caddy").value = "9443";
  get("port-caddy").input();
  await get("ports-form").onsubmit(event());
  await snapshot({
    portsRevision: 1,
    ports: { ...ports, caddy: 9443 },
    deployment: { appId: "cli_one", appSecret: "secret-one", frpc: "localPort = 9443" },
  });
  assert.equal(get("frpc-content").value, "serverPort = 7000\n# unsaved edit");
});

test("waiting for service readiness keeps configuration, stop and restart controls available", async () => {
  const { get, snapshot, sent } = await editor({ phase: "starting" });
  for (const id of [
    "app-id",
    "frpc-content",
    "port-caddy",
    "save-connections",
    "save-ports",
    "stop",
  ])
    assert.equal(get(id).disabled, false, id);
  get("port-caddy").value = "9443";
  get("port-caddy").input();
  await get("ports-form").onsubmit(event());
  assert.equal(sent[0].action, "ports");
  await snapshot({ configRevision: 1, portsRevision: 1, restartRequired: true });
  assert.equal(get("restart-dialog").open, true);
  assert.equal(get("restart-now").disabled, false);
  assert.equal(get("restart-service").disabled, false);
  get("restart-later").onclick();
  await get("stop").onclick();
  assert.equal(sent[1].action, "stop");
  await snapshot({ phase: "stopping" });
  assert.equal(get("save-connections").disabled, true);
  assert.equal(get("save-ports").disabled, true);
});

test("dialog Tab explicitly moves focus in both directions without browser button navigation", async () => {
  const { get, snapshot, active } = await editor();
  await snapshot({ configRevision: 1, restartRequired: true });
  const tab = (shiftKey = false) => {
    let prevented = false;
    get("restart-dialog").onkeydown({
      key: "Tab",
      shiftKey,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
  };
  get("restart-later").focus();
  tab();
  assert.equal(active(), get("restart-now"));
  tab();
  assert.equal(active(), get("restart-later"));
  tab(true);
  assert.equal(active(), get("restart-now"));
  tab(true);
  assert.equal(active(), get("restart-later"));
  get("app-id").focus();
  tab();
  assert.equal(active(), get("restart-later"));
  get("app-id").focus();
  tab(true);
  assert.equal(active(), get("restart-now"));
});

test("incomplete first launch opens setup once while configured installs keep overview", async () => {
  const configured = await editor();
  assert.equal(configured.get("overview").hidden, false);
  const fresh = await editor({ deployment: {} });
  assert.equal(fresh.get("guide").hidden, false);
  assert.equal(fresh.get("overview").hidden, true);
  fresh.get("nav-connections").onclick();
  await fresh.snapshot({ deployment: {} });
  assert.equal(fresh.get("connections").hidden, false);
  assert.equal(fresh.get("guide").hidden, true);
});

test("setup checks current connection drafts without saving or using unsaved ports", async () => {
  const { get, sent, snapshot } = await editor({
    setupContext: {
      origin: "https://tasks.example.com",
      domain: "tasks.example.com",
      caddyPort: 8443,
    },
  });
  get("app-id").value = "cli_draft";
  get("app-id").input();
  get("port-caddy").value = "9443";
  get("port-caddy").input();
  await get("setup-check-feishu").onclick();
  assert.equal(sent[0].action, "setup_check");
  assert.deepEqual(Object.keys(sent[0].settings).sort(), [
    "appId",
    "appSecret",
    "frpc",
    "requestKey",
    "section",
  ]);
  assert.equal(sent[0].settings.appId, "cli_draft");
  assert.equal(sent[0].settings.section, "feishu");
  assert.equal(get("setup-caddy-port").textContent, "8443");
  await snapshot({
    setup: {
      checking: false,
      requestKey: sent[0].settings.requestKey,
      results: [],
      checkedAt: "2026-09-12T00:00:00Z",
    },
  });
  await get("setup-check-all").onclick();
  assert.equal(sent[1].settings.section, "all");
  assert.equal(get("restart-dialog").open, false);
});

test("startup configuration loading does not claim unchecked configuration has changed", async () => {
  const { get, sent, snapshot } = await editor({
    phase: "starting",
    deployment: undefined,
    ports: undefined,
  });
  assert.equal(get("setup-stale").hidden, true);
  await snapshot({
    phase: "ready",
    ports,
    deployment: { appId: "cli_one", appSecret: "secret-one", frpc: "serverPort = 7000" },
  });
  assert.equal(get("setup-stale").hidden, true);
  await snapshot({});
  assert.equal(get("setup-stale").hidden, true);
  get("app-id").value = "cli_draft";
  get("app-id").input();
  assert.equal(get("setup-stale").hidden, true);
  await get("setup-check-feishu").onclick();
  assert.equal(get("setup-stale").hidden, true);
  await snapshot({
    setup: {
      requestKey: sent[0].settings.requestKey,
      checkedAt: "2026-09-14T00:00:00Z",
      results: [{ id: "credentials", section: "feishu", status: "passed", message: "有效" }],
    },
  });
  assert.equal(get("setup-stale").hidden, true);
  get("app-id").value = "cli_changed";
  get("app-id").input();
  assert.equal(get("setup-stale").hidden, false);
});

test("editing during a setup check keeps arriving results stale until checking the new input", async () => {
  const { get, sent, snapshot } = await editor();
  await get("setup-check-all").onclick();
  const first = sent[0].settings.requestKey;
  await snapshot({ setup: { checking: true, requestKey: first, section: "all", results: [] } });
  get("app-secret").value = "changed-secret";
  get("app-secret").input();
  assert.equal(get("setup-stale").hidden, false);
  await snapshot({
    setup: {
      checking: false,
      requestKey: first,
      checkedAt: "2026-09-12T00:00:00Z",
      results: [
        { id: "credentials", section: "feishu", title: "凭据", status: "passed", message: "有效" },
      ],
    },
  });
  assert.equal(get("setup-stale").hidden, false);
  assert.notEqual(get("setup-status-feishu").textContent, "通过");
  await get("setup-check-all").onclick();
  await snapshot({
    setup: {
      checking: false,
      requestKey: sent[1].settings.requestKey,
      checkedAt: "2026-09-12T00:01:00Z",
      results: [
        { id: "credentials", section: "feishu", title: "凭据", status: "passed", message: "有效" },
      ],
    },
  });
  assert.equal(get("setup-stale").hidden, true);
  assert.equal(get("setup-status-feishu").textContent, "通过");
});

test("setup results are text nodes and manual checks never count as completed", async () => {
  const { get, snapshot } = await editor();
  await snapshot({
    setup: {
      checking: false,
      checkedAt: "2026-09-12T00:00:00Z",
      results: [
        {
          id: "publish",
          section: "feishu",
          title: "<img src=x onerror=alert(1)>",
          status: "manual",
          message: "<script>bad()</script>",
          details: ["<b>发布</b>"],
        },
      ],
    },
  });
  assert.equal(get("setup-status-feishu").textContent, "需确认");
  const row = get("setup-results-feishu").children[0];
  assert.equal(row.children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(row.children[1].textContent, "<script>bad()</script>");
  assert.equal(row.children[2].children[0].textContent, "<b>发布</b>");
});

test("guide navigates to existing form and opening Codex uses a fixed target", async () => {
  const { get, sent, active } = await editor({ deployment: {} });
  get("setup-link-feishu").onclick(event());
  assert.equal(get("breadcrumb").textContent, "连接配置");
  get("setup-configure-feishu").onclick();
  assert.equal(get("connections").hidden, false);
  assert.equal(active(), get("app-id"));
  await get("setup-open-codex").onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), {
    action: "setup_open",
    settings: { target: "codex-app" },
  });
  assert.equal(
    sent.some((entry) => entry.action === "deployment"),
    false,
  );
});

test("guide copies a homepage with trailing slash and an unmodified DNS hostname", async () => {
  const { get, copied } = await editor({
    setupContext: { origin: "https://tasks.example.com", domain: "tasks.example.com" },
  });
  assert.equal(get("setup-origin").textContent, "https://tasks.example.com/");
  await get("setup-copy-origin").onclick();
  await get("setup-copy-dns").onclick();
  assert.deepEqual(copied, ["https://tasks.example.com/", "tasks.example.com"]);
});

test("HTTP guide keeps the public port, separates trusted origin from redirect URL, and warns about plaintext", async () => {
  const { get, copied } = await editor({
    setupContext: {
      origin: "http://8.8.8.8:18080",
      domain: "8.8.8.8",
      caddyPort: 8443,
    },
  });
  assert.equal(get("setup-origin").textContent, "http://8.8.8.8:18080/");
  assert.equal(get("setup-trusted-origin").textContent, "http://8.8.8.8:18080");
  assert.equal(get("setup-public-origin").textContent, "http://8.8.8.8:18080");
  assert.equal(get("setup-http-warning").hidden, false);
  assert.match(get("setup-http-warning").textContent, /HTTP.*明文.*风险/);
  assert.match(get("setup-dns-description").textContent, /公网 IP:端口.*无需.*域名/);
  assert.equal(get("setup-domain-instructions").hidden, true);
  assert.equal(get("setup-check-dns").textContent, "检查访问");
  await get("setup-copy-origin").onclick();
  await get("setup-copy-trusted-origin").onclick();
  await get("setup-copy-public-origin").onclick();
  assert.deepEqual(copied, [
    "http://8.8.8.8:18080/",
    "http://8.8.8.8:18080",
    "http://8.8.8.8:18080",
  ]);
});

test("HTTP guide displays the public IP address from the runtime's minimal setup context", async () => {
  const { get } = await editor({
    setupContext: {
      origin: "http://8.8.8.8",
      domain: "8.8.8.8",
      caddyPort: 8443,
    },
  });
  assert.equal(get("setup-public-origin").textContent, "http://8.8.8.8");
  assert.equal(get("setup-http-warning").hidden, false);
});

test("HTTPS guide displays the DNS hostname with the runtime's minimal setup context", async () => {
  const { get } = await editor({
    setupContext: {
      origin: "https://tasks.example.com",
      domain: "tasks.example.com",
      caddyPort: 8443,
    },
  });
  assert.equal(get("setup-dns-domain").textContent, "tasks.example.com");
  assert.equal(get("setup-http-warning").hidden, true);
});

test("a single section recheck cannot refresh retained results for an older configuration", async () => {
  const { get, sent, snapshot } = await editor();
  const results = ["feishu", "dns"].map((section) => ({
    id: section,
    section,
    title: section,
    status: "passed",
    message: "有效",
  }));
  await snapshot({ setup: { results, checkedAt: "2026-09-12T00:00:00Z" } });
  get("frpc-content").value = "serverPort = 7001";
  get("frpc-content").input();
  await get("setup-check-feishu").onclick();
  await snapshot({
    setup: {
      results,
      checkedAt: "2026-09-12T00:01:00Z",
      requestKey: sent[0].settings.requestKey,
    },
  });
  assert.equal(get("setup-status-feishu").textContent, "通过");
  assert.equal(get("setup-status-tunnel").textContent, "已过期");
  assert.equal(get("setup-results-dns").children[0].children[0].children[1].textContent, "已过期");
  assert.equal(get("setup-stale").hidden, false);
});

test("guide uses the last checked draft context without falling back to an unrelated saved domain", async () => {
  const { get, copied, snapshot } = await editor({
    setupContext: {
      origin: "https://saved.example.com",
      domain: "saved.example.com",
      caddyPort: 8443,
    },
    setup: {
      context: {
        origin: "https://draft.example.com",
        domain: "draft.example.com",
        caddyPort: 8443,
      },
    },
  });
  assert.equal(get("setup-origin").textContent, "https://draft.example.com/");
  await get("setup-copy-dns").onclick();
  assert.equal(copied[0], "draft.example.com");
  await snapshot({ setup: { context: { origin: "", domain: "", caddyPort: 8443 } } });
  assert.equal(get("setup-copy-origin").disabled, true);
  assert.doesNotMatch(get("setup-origin").textContent, /saved.example/);
});

test("DNS guide displays and copies the IPv4 A record target from context", async () => {
  const { get, copied } = await editor({
    setupContext: {
      origin: "https://tasks.example.com",
      domain: "tasks.example.com",
      dnsTarget: "8.8.8.8",
      dnsRecordType: "A",
    },
  });
  assert.equal(get("setup-dns-target-label").textContent, "A 记录值");
  assert.equal(get("setup-dns-target").textContent, "8.8.8.8");
  assert.equal(get("setup-dns-target-row").hidden, false);
  assert.match(get("setup-domain-instructions").textContent, /添加 A 记录/);
  await get("setup-copy-dns-target").onclick();
  assert.deepEqual(copied, ["8.8.8.8"]);
});

test("unchanged saves do not reopen restart prompt, including an existing deferred restart", async () => {
  for (const restartRequired of [false, true]) {
    const { get, snapshot } = await editor({ configRevision: 3, restartRequired });
    get("app-id").value = "cli_temporary";
    get("app-id").input();
    get("app-id").value = "cli_one";
    get("app-id").input();
    await get("connections-form").onsubmit(event());
    await snapshot({
      deploymentRevision: 1,
      configRevision: 3,
      restartRequired,
      deploymentMessage: "配置未更改。",
    });
    assert.equal(get("restart-dialog").open, false);
    assert.equal(get("connections-result").textContent, "配置未更改。");
    assert.equal(get("restart-notice").hidden, !restartRequired);
  }
});

test("guide has three steps with DNS, public access and both checks in the frp step", () => {
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const steps = [
    ...html.matchAll(/<details class="setup-step" id="([^"]+)"[^>]*>([\s\S]*?)<\/details>/g),
  ];
  assert.deepEqual(
    steps.map((step) => step[1]),
    ["setup-step-tunnel", "setup-step-feishu", "setup-step-codex"],
  );
  for (const id of [
    "setup-dns-domain-row",
    "setup-dns-target-row",
    "setup-public-origin",
    "setup-copy-public-origin",
    "setup-check-tunnel",
    "setup-check-dns",
    "setup-results-tunnel",
    "setup-results-dns",
  ])
    assert.ok(steps[0][2].includes(`id="${id}"`), id);
  assert.match(html, /id="setup-intro"[^>]*>按三步完成连接。/);
  assert.match(steps[1][2], /id="setup-number-feishu"[^>]*>2</);
  assert.match(steps[2][2], /id="setup-number-codex"[^>]*>3</);
  assert.doesNotMatch(html, /setup-step-dns|setup-status-dns/);
  assert.match(
    html,
    /<aside class="setup-contact">\s*如果没有 frp 服务器（步骤 1），联系作者购买，微信号：rocyan921。\s*<\/aside>/,
  );
});

test("HTTPS and HTTP need DNS while switching to TCP hides DNS and keeps public access available", async () => {
  const { get, snapshot, copied, sent } = await editor();
  for (const protocol of ["https", "http", "https"]) {
    await snapshot({
      setupContext: {
        origin: `${protocol}://tasks.example.com`,
        domain: "tasks.example.com",
        dnsTarget: "8.8.8.8",
        dnsRecordType: "A",
      },
    });
    for (const id of ["setup-dns-domain-row", "setup-dns-target-row", "setup-domain-instructions"])
      assert.equal(get(id).hidden, false, id);
    assert.match(
      get("setup-dns-description").textContent,
      new RegExp(`^${protocol.toUpperCase()}.*需要.*DNS`),
    );
    assert.equal(get("setup-copy-dns").disabled, false);
    assert.equal(get("setup-copy-dns-target").disabled, false);
    assert.equal(get("setup-public-origin").textContent, `${protocol}://tasks.example.com`);

    await snapshot({
      setupContext: {
        origin: "http://8.8.8.8:18080",
        domain: "8.8.8.8",
        dnsTarget: "8.8.8.8",
        dnsRecordType: "A",
      },
    });
    for (const id of ["setup-dns-domain-row", "setup-dns-target-row", "setup-domain-instructions"])
      assert.equal(get(id).hidden, true, id);
    assert.match(get("setup-dns-description").textContent, /^TCP.*无需.*DNS/);
    assert.equal(get("setup-copy-dns").disabled, true);
    assert.equal(get("setup-copy-dns-target").disabled, true);
    assert.equal(get("setup-copy-public-origin").disabled, false);
    assert.equal(get("setup-check-dns").disabled, false);
    assert.equal(get("setup-public-origin").textContent, "http://8.8.8.8:18080");
  }
  await get("setup-copy-public-origin").onclick();
  assert.deepEqual(copied, ["http://8.8.8.8:18080"]);
  await get("setup-check-dns").onclick();
  assert.equal(sent[0].action, "setup_check");
  assert.equal(sent[0].settings.section, "dns");
  assert.equal(get("setup-status-tunnel").textContent, "检查中");
});

test("unconfigured and invalid entries do not claim HTTPS or DNS is unnecessary", async () => {
  const { get, snapshot } = await editor();
  for (const context of [{}, { origin: "", domain: "" }, { domain: "tasks.example.com" }]) {
    await snapshot({ setup: { context } });
    assert.match(get("setup-dns-description").textContent, /填写并检查/);
    assert.doesNotMatch(get("setup-dns-description").textContent, /HTTPS|TCP|无需/);
    for (const id of [
      "setup-dns-domain-row",
      "setup-dns-target-row",
      "setup-domain-instructions",
      "setup-http-warning",
    ])
      assert.equal(get(id).hidden, true, id);
    for (const id of ["setup-copy-dns", "setup-copy-dns-target", "setup-copy-public-origin"])
      assert.equal(get(id).disabled, true, id);
  }
});

test("frp step only passes after tunnel and access both pass", async () => {
  const { get, snapshot } = await editor();
  for (const [tunnel, dns, expected] of [
    ["passed", undefined, "未检查"],
    [undefined, "passed", "未检查"],
    ["passed", "failed", "需处理"],
    ["failed", "passed", "需处理"],
    ["passed", "warning", "需确认"],
    ["passed", "manual", "需确认"],
    ["passed", "passed", "通过"],
  ]) {
    const results = Object.entries({ tunnel, dns })
      .filter(([, status]) => status)
      .map(([section, status]) => ({ id: section, section, status }));
    await snapshot({ setup: { checkedAt: "2026-09-14T00:00:00Z", results } });
    assert.equal(get("setup-status-tunnel").textContent, expected, JSON.stringify({ tunnel, dns }));
  }
});

test("frp summary follows either check and keeps older access results stale after tunnel recheck", async () => {
  const { get, snapshot, sent } = await editor();
  const results = ["tunnel", "dns"].map((section) => ({ id: section, section, status: "passed" }));
  await snapshot({ setup: { checkedAt: "2026-09-14T00:00:00Z", results } });
  assert.equal(get("setup-status-tunnel").textContent, "通过");
  get("frpc-content").value = "serverPort = 7001";
  get("frpc-content").input();
  assert.equal(get("setup-status-tunnel").textContent, "已过期");
  for (const [index, section] of ["tunnel", "dns", "all"].entries()) {
    await get(`setup-check-${section}`).onclick();
    assert.equal(sent[index].settings.section, section);
    assert.equal(get("setup-status-tunnel").textContent, "检查中");
    for (const check of ["tunnel", "dns", "feishu", "codex", "all"])
      assert.equal(get(`setup-check-${check}`).disabled, true, check);
    await snapshot({
      setup: { checking: true, section, results, requestKey: sent[index].settings.requestKey },
    });
    assert.equal(get("setup-status-tunnel").textContent, "检查中");
    await snapshot({
      setup: {
        checking: false,
        section,
        checkedAt: "2026-09-14T00:01:00Z",
        results,
        requestKey: sent[index].settings.requestKey,
      },
    });
    assert.equal(get("setup-status-tunnel").textContent, index === 0 ? "已过期" : "通过");
    assert.equal(get("setup-stale").hidden, index !== 0);
  }
});
