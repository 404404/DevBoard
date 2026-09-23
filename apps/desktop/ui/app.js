const invoke = window.__TAURI__?.core.invoke;
const $ = (id) => document.getElementById(id);
// Snapshot polling must not replace text nodes that the user is copying.
function hasSelectedText(element) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++)
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  return false;
}
function setText(element, value) {
  const text = String(value ?? "");
  if (element.textContent !== text && !hasSelectedText(element)) element.textContent = text;
}
const renderedLists = new WeakMap();
function renderList(element, data, createNodes) {
  const signature = JSON.stringify(data);
  if (renderedLists.get(element) === signature || hasSelectedText(element)) return;
  element.replaceChildren(...createNodes());
  renderedLists.set(element, signature);
}
let pending = false;
const dirtyFields = new Set();
const submittedFields = new Map();
let deploymentRevision = 0;
let portsRevision = 0;
let configRevision = null;
let restartPromptPending = false;
let snapshot = {};
let portsValidationError = "";
let initialPageChosen = false;
let navigationTouched = false;
let setupInputSignature = null;
let setupInputRevision = 0;
let setupFreshRevision = 0;
let setupRequestSequence = 0;
let setupQueuedKey = "";
let setupLatestRequestKey = "";
const setupRequests = new Map();
const setupCheckedVersions = new Map();
const setupSections = ["tunnel", "dns", "feishu", "web", "codex"];
const setupSteps = {
  tunnel: ["tunnel", "dns"],
  feishu: ["feishu"],
  web: ["web"],
  codex: ["codex"],
};
const pageNames = {
  overview: "服务概览",
  guide: "使用引导",
  connections: "连接配置",
  settings: "应用设置",
  logs: "运行日志",
};
let guideAccessMode = "feishu";
const connectionFields = [
  "app-id",
  "app-secret",
  "public-access-mode",
  "public-origin",
  "listen-address",
  "frpc-content",
];
const portFields = [
  ["port-api", "api"],
  ["port-admin", "admin"],
  ["port-bridge", "bridge"],
  ["port-caddy", "caddy"],
];
const labels = {
  starting: "正在连接",
  ready: "运行正常",
  stopped: "已停止",
  stopping: "正在停止",
  error: "需要处理",
};
const names = ["DevBoard 后端", "Caddy", "公网隧道"];
async function action(name, args = {}) {
  if (pending || !invoke) return false;
  pending = true;
  renderControls();
  try {
    await invoke(name, args);
    $("error").textContent = "";
    return true;
  } catch (e) {
    $("error").textContent = String(e);
    return false;
  } finally {
    pending = false;
    renderControls();
  }
}
$("start").onclick = () => action("control", { action: "start" });
$("stop").onclick = () => action("control", { action: "stop" });
$("connections-form").onsubmit = async (event) => {
  event.preventDefault();
  if (pending || $("save-connections").disabled) return;
  $("save-connections").disabled = true;
  for (const id of connectionFields) submittedFields.set(id, $(id).value);
  await action("control", {
    action: "deployment",
    settings: {
      appId: $("app-id").value,
      appSecret: document.getElementById("app-secret").value,
      publicAccessMode: document.getElementById("public-access-mode").value,
      publicOrigin: document.getElementById("public-origin").value,
      listenAddress: document.getElementById("listen-address").value,
      frpc: document.getElementById("frpc-content").value,
    },
  });
};
$("ports-form").onsubmit = async (event) => {
  event.preventDefault();
  if (pending || $("save-ports").disabled) return;
  const settings = {};
  const localPorts = new Set();
  for (const [id, key] of portFields) {
    const value = Number($(id).value);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      portsValidationError = "端口必须是 1 到 65535 之间的整数。";
      $("ports-result").textContent = portsValidationError;
      $(id).focus();
      return;
    }
    if (localPorts.has(value)) {
      portsValidationError = "后端、本机管理、Codex 桥接和 Caddy 的本机端口不能重复。";
      $("ports-result").textContent = portsValidationError;
      $(id).focus();
      return;
    }
    localPorts.add(value);
    settings[key] = value;
  }
  portsValidationError = "";
  $("ports-result").textContent = "";
  for (const [id] of portFields) submittedFields.set(id, $(id).value);
  await action("control", { action: "ports", settings });
};
for (const id of [...connectionFields, ...portFields.map(([id]) => id)])
  $(id).addEventListener("input", () => {
    dirtyFields.add(id);
    if (id.startsWith("port-")) portsValidationError = "";
    if (connectionFields.includes(id)) {
      observeSetupInputs();
      renderSetup();
    }
  });
async function restart() {
  $("restart-error").hidden = true;
  if (await action("control", { action: "restart" })) {
    restartPromptPending = false;
    $("restart-dialog").close();
  } else if ($("error").textContent) {
    $("restart-error").textContent = $("error").textContent;
    $("restart-error").hidden = false;
  }
}
$("restart-service").onclick = restart;
$("restart-now").onclick = restart;
$("restart-later").onclick = () => $("restart-dialog").close();
$("restart-dialog").onclose = () => {
  restartPromptPending = false;
};
$("restart-dialog").oncancel = (event) => {
  if (pending) event.preventDefault();
};
$("restart-dialog").onkeydown = (event) => {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const buttons = [$("restart-later"), $("restart-now")].filter((button) => !button.disabled);
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement);
  const next =
    current < 0
      ? event.shiftKey
        ? buttons.length - 1
        : 0
      : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next].focus();
};
$("show-secret").onclick = () => {
  const visible = $("app-secret").type === "password";
  $("app-secret").type = visible ? "text" : "password";
  $("show-secret").textContent = visible ? "隐藏密钥" : "显示密钥";
};
for (const button of document.querySelectorAll("[data-tab]"))
  button.onclick = () => showPage(button.dataset.tab);
function showPage(tab, focusId, automatic = false) {
  if (!pageNames[tab]) return;
  if (!automatic) navigationTouched = true;
  for (const button of document.querySelectorAll("[data-tab]"))
    button.classList.toggle("selected", button.dataset.tab === tab);
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== tab;
  $("breadcrumb").textContent = pageNames[tab];
  if (focusId) {
    if (tab === "connections") $("connections-card").open = true;
    $(focusId).focus();
  }
}
$("overview-guide").onclick = () => showPage("guide");
for (const [id, field] of [
  ["setup-configure-feishu", "app-id"],
  ["setup-configure-tunnel", "frpc-content"],
  ["setup-save", "app-id"],
])
  $(id).onclick = () => showPage("connections", field);
$("setup-link-feishu").onclick = (event) => {
  event.preventDefault();
  showPage("connections", "app-id");
};
const setupExternalTargets = {
  "setup-open-feishu": "feishu-console",
  "setup-open-codex": "codex-app",
  "setup-download-codex": "codex-download",
};
for (const [id, target] of Object.entries(setupExternalTargets))
  $(id).onclick = () => action("control", { action: "setup_open", settings: { target } });
$("setup-open-board").onclick = () =>
  guideAccessMode === "web"
    ? action("control", { action: "open_web_board" })
    : action("open_board");
$("setup-configure-web").onclick = () => {
  showPage("settings");
  $("web-accounts-card").open = true;
  $("web-username").focus();
  action("control", { action: "web_accounts", settings: { operation: "list" } });
};
$("connections-web-accounts").onclick = $("setup-configure-web").onclick;
document.getElementById("setup-access-mode").onchange = () => {
  guideAccessMode = document.getElementById("setup-access-mode").value;
  setupInputRevision++;
  renderSetup();
};
document.getElementById("public-access-mode").onchange = () => {
  setupInputRevision++;
  renderSetup();
};
$("setup-save").onclick = () =>
  showPage("connections", guideAccessMode === "web" ? "frpc-content" : "app-id");
function setupContext() {
  return snapshot.setup?.context || snapshot.setupContext || {};
}
function setupDisplayValue(key) {
  const value = setupContext()[key];
  if (typeof value !== "string" || !value) return "";
  return key === "origin" ? value.replace(/\/+$/, "") + "/" : value;
}
function setupIsHttp() {
  const context = setupContext();
  return context.protocol === "http:" || context.origin?.startsWith("http://");
}
for (const [id, key] of [
  ["setup-copy-origin", "origin"],
  ["setup-copy-public-origin", "origin"],
  ["setup-copy-trusted-origin", "trustedOrigin"],
  ["setup-copy-dns", "domain"],
  ["setup-copy-dns-target", "dnsTarget"],
])
  $(id).onclick = async () => {
    const value =
      key === "trustedOrigin" || id === "setup-copy-public-origin"
        ? setupContext().origin?.replace(/\/+$/, "")
        : setupDisplayValue(key);
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      $("setup-notice").textContent = "已复制";
    } catch {
      $("setup-notice").textContent = "复制失败，请选中文字后复制。";
    }
  };
function observeSetupInputs() {
  const signature = JSON.stringify([
    ...connectionFields.map((id) => $(id).value),
    snapshot.ports?.caddy,
  ]);
  if (setupInputSignature !== null && signature !== setupInputSignature) setupInputRevision++;
  setupInputSignature = signature;
}
for (const section of [...setupSections, "all"])
  $("setup-check-" + section).onclick = async () => {
    if (pending || snapshot.setup?.checking || setupQueuedKey || !invoke) return;
    observeSetupInputs();
    const requestKey = `setup-${Date.now()}-${++setupRequestSequence}`;
    setupLatestRequestKey = setupQueuedKey = requestKey;
    setupRequests.set(requestKey, { revision: setupInputRevision, section });
    const settings = {
      section,
      requestKey,
      accessMode: guideAccessMode,
      appId: $("app-id").value,
      appSecret: document.getElementById("app-secret").value,
      publicAccessMode: document.getElementById("public-access-mode").value,
      publicOrigin: document.getElementById("public-origin").value,
      listenAddress: document.getElementById("listen-address").value,
      frpc: document.getElementById("frpc-content").value,
    };
    renderSetup();
    if (!(await action("control", { action: "setup_check", settings }))) {
      setupQueuedKey = "";
      setupRequests.delete(requestKey);
    }
    renderSetup();
  };
function renderSetup() {
  const web = guideAccessMode === "web";
  const publicMode =
    document.getElementById("public-access-mode").value ||
    snapshot.deployment?.publicAccessMode ||
    "builtin-frp";
  const externalPublic = publicMode === "external-reverse-proxy";
  document.getElementById("public-origin").required = externalPublic;
  document.getElementById("frpc-content").required = publicMode === "builtin-frp";
  setText(
    document.getElementById("public-access-help"),
    publicMode === "builtin-frp"
      ? "DevBoard 启动本机 Caddy 和 frpc；旧版 frpc.toml 可直接继续使用。"
      : publicMode === "external-reverse-proxy"
        ? "DevBoard 启动本机 HTTP Caddy，但不启动 frpc；外部代理终止 TLS 后转发到 Caddy 监听地址。"
        : "仅启动本机后端，不启动 Caddy 或 frpc；Web 账号可通过本机地址使用。",
  );
  $("setup-access-mode").value = web ? "web" : "feishu";
  $("setup-access-mode").disabled =
    pending || Boolean(snapshot.deploymentSaving || snapshot.setup?.checking);
  $("setup-step-feishu").hidden = web;
  $("setup-step-web").hidden = !web;
  $("app-id").required = Boolean($("app-secret").value);
  $("app-secret").required = Boolean($("app-id").value);
  setText(
    $("setup-mode-help"),
    web
      ? "Web 引导：配置 HTTPS 并在本机创建账号。"
      : "飞书引导：配置应用凭据并发布。已有 Web 账号仍可从浏览器登录。",
  );
  setText($("setup-finish-title"), web ? "保存配置，再到浏览器验证" : "保存配置，再到飞书验证");
  setText(
    $("setup-finish-description"),
    web
      ? "保存配置并重启服务，创建 Web 账号后在浏览器登录。"
      : "保存配置并重启服务后，从飞书打开应用验证。",
  );
  setText($("setup-open-board"), web ? "打开 Web 验证 ↗" : "打开飞书验证 ↗");
  const setup = snapshot.setup || {};
  const context = setupContext();
  const results = Array.isArray(setup.results) ? setup.results : [];
  const request = setupRequests.get(setup.requestKey);
  if (setup.requestKey === setupQueuedKey) setupQueuedKey = "";
  if (!setup.checking && setup.checkedAt && request) {
    for (const section of setupSections)
      if (request.section === "all" || request.section === section)
        setupCheckedVersions.set(section, request.revision);
    if (setup.requestKey === setupLatestRequestKey && request.revision === setupInputRevision)
      setupFreshRevision = setupInputRevision;
    setupRequests.delete(setup.requestKey);
  }
  const resultStale = (section) =>
    Boolean(setup.stale) || (setupCheckedVersions.get(section) ?? 0) !== setupInputRevision;
  const stale =
    Boolean(setup.stale) ||
    (Boolean(setup.checkedAt) && setupFreshRevision !== setupInputRevision) ||
    [...setupRequests.values()].some((pending) => pending.revision !== setupInputRevision) ||
    results.some((result) => resultStale(result.section));
  const checking = Boolean(setup.checking || setupQueuedKey);
  const checkingSection = setupQueuedKey
    ? setupRequests.get(setupQueuedKey)?.section
    : setup.section;
  $("setup-stale").hidden = !stale;
  $("setup-error").hidden = !setup.error;
  setText($("setup-error"), setup.error || "");
  setText(
    $("setup-notice"),
    checking ? "正在检查，请稍候。配置不会自动保存。" : setup.notice || "",
  );
  setText($("setup-checked-at"), setup.checkedAt ? "最近检查：" + setup.checkedAt : "");
  const http = setupIsHttp();
  const origin = typeof context.origin === "string" ? context.origin.replace(/\/+$/, "") : "";
  setText($("setup-trusted-origin"), origin || "请先填写有效的 frpc.toml");
  $("setup-http-warning").hidden = !origin || !http;
  setText($("setup-http-warning"), "HTTP 为明文传输，登录会话和业务数据存在被窃取或篡改的风险。");
  const hasEntry = Boolean(origin && context.domain);
  const ipEntry = hasEntry && /^\d+\.\d+\.\d+\.\d+$/.test(context.domain);
  const domainEntry = hasEntry && !ipEntry;
  setText(
    $("setup-dns-description"),
    ipEntry
      ? "TCP 可直接用“公网 IP:端口”访问，无需配置 DNS 域名解析。"
      : domainEntry
        ? `${http ? "HTTP" : "HTTPS"} 使用域名访问，需要配置 DNS 域名解析。`
        : "填写并检查 frpc.toml 后，将按隧道类型显示是否需要 DNS 解析。",
  );
  $("setup-dns-domain-row").hidden = !domainEntry;
  $("setup-domain-instructions").hidden = !domainEntry;
  $("setup-dns-target-row").hidden = !domainEntry;
  setText(
    $("setup-dns-target-label"),
    context.dnsRecordType ? `${context.dnsRecordType} 记录值` : "解析目标",
  );
  setText($("setup-dns-target"), context.dnsTarget || "请先填写 frpc.toml");
  setText(
    $("setup-domain-instructions"),
    context.dnsTarget && context.dnsRecordType
      ? `添加 ${context.dnsRecordType} 记录，将上方域名指向此记录值。`
      : "请先填写有效的 frpc.toml serverAddr 以获取解析目标。",
  );
  setText($("setup-check-dns"), "检查访问");
  setText($("setup-origin"), setupDisplayValue("origin") || "请先填写 frpc.toml");
  setText($("setup-public-origin"), origin || "请先填写 frpc.toml");
  setText($("setup-dns-domain"), context.domain || "请先填写 frpc.toml");
  setText($("setup-caddy-port"), String(snapshot.ports?.caddy ?? context.caddyPort ?? "—"));
  for (const [id, key] of [
    ["setup-copy-origin", "origin"],
    ["setup-copy-public-origin", "origin"],
    ["setup-copy-trusted-origin", "origin"],
    ["setup-copy-dns", "domain"],
    ["setup-copy-dns-target", "dnsTarget"],
  ])
    $(id).disabled =
      typeof context[key] !== "string" ||
      !context[key] ||
      (["setup-copy-dns", "setup-copy-dns-target"].includes(id) && !domainEntry);
  const statusLabels = { passed: "通过", failed: "需处理", warning: "需确认", manual: "需确认" };
  for (const [step, sections] of Object.entries(setupSteps)) {
    const matching = results.filter((result) => sections.includes(result.section));
    const active = checking && (sections.includes(checkingSection) || checkingSection === "all");
    const sectionStale = matching.some((result) => resultStale(result.section));
    const status = active
      ? "checking"
      : sectionStale
        ? "stale"
        : !matching.length
          ? "unchecked"
          : matching.some((result) => result.status === "failed")
            ? "failed"
            : matching.some((result) => result.status !== "passed")
              ? "manual"
              : sections.some((section) => !matching.some((result) => result.section === section))
                ? "unchecked"
                : "passed";
    setText(
      $("setup-status-" + step),
      {
        checking: "检查中",
        stale: "已过期",
        unchecked: "未检查",
        ...statusLabels,
      }[status],
    );
    $("setup-status-" + step).className = "setup-status " + status;
  }
  for (const section of setupSections) {
    const matching = results.filter((result) => result.section === section);
    const sectionStale = matching.length > 0 && resultStale(section);
    renderList($("setup-results-" + section), [matching, sectionStale], () =>
      matching.map((result) => {
        const row = document.createElement("div");
        row.className = "setup-result";
        const heading = document.createElement("div");
        heading.className = "setup-result-heading";
        const title = document.createElement("strong");
        title.textContent = result.title || "检查项目";
        const badge = document.createElement("span");
        badge.className =
          "setup-status " +
          (sectionStale
            ? "stale"
            : Object.hasOwn(statusLabels, result.status)
              ? result.status
              : "manual");
        badge.textContent = sectionStale ? "已过期" : statusLabels[result.status] || "需确认";
        heading.append(title, badge);
        const message = document.createElement("p");
        message.textContent = result.message || "";
        row.append(heading, message);
        if (Array.isArray(result.details) && result.details.length) {
          const details = document.createElement("ul");
          for (const value of result.details) {
            const item = document.createElement("li");
            item.textContent = value;
            details.append(item);
          }
          row.append(details);
        }
        return row;
      }),
    );
  }
  for (const section of [...setupSections, "all"])
    $("setup-check-" + section).disabled =
      pending || checking || Boolean(snapshot.deploymentSaving || snapshot.portsSaving);
  $("setup-check-all").textContent =
    checking && checkingSection === "all" ? "正在检查…" : "检查全部";
  $("setup-open-board").disabled = pending || Boolean(snapshot.boardOpening);
}
function render(s) {
  renderWebAccounts(s);
  snapshot = s;
  setText($("status"), labels[s.phase] || "正在连接");
  $("status").className = "badge " + s.phase;
  setText($("message"), s.message);
  setText($("open-error"), s.boardOpenError || "");
  for (const [id, value] of [
    ["directory", s.settings?.configDirectory || ""],
    ["codex", s.settings?.codexPath || ""],
  ])
    if ($(id).value !== value && document.activeElement !== $(id)) $(id).value = value;
  const deployment = s.deployment || {};
  if ((s.deploymentRevision || 0) > deploymentRevision) {
    deploymentRevision = s.deploymentRevision;
    acknowledgeFields(connectionFields);
  }
  if ((s.portsRevision || 0) > portsRevision) {
    portsRevision = s.portsRevision;
    acknowledgeFields(portFields.map(([id]) => id));
  }
  for (const [id, key] of portFields) {
    if (!dirtyFields.has(id) && document.activeElement !== $(id))
      $(id).value = s.ports?.[key] ?? "";
  }
  const revision = s.configRevision || 0;
  if (configRevision !== null && revision > configRevision && s.restartRequired) {
    restartPromptPending = true;
  }
  configRevision = revision;
  for (const [id, key] of [
    ["app-id", "appId"],
    ["app-secret", "appSecret"],
    ["public-access-mode", "publicAccessMode"],
    ["public-origin", "publicOrigin"],
    ["listen-address", "listenAddress"],
    ["frpc-content", "frpc"],
  ])
    if (!dirtyFields.has(id) && document.activeElement !== $(id))
      $(id).value = deployment[key] || "";
  observeSetupInputs();
  if (!initialPageChosen && s.deployment) {
    initialPageChosen = true;
    if (!navigationTouched)
      showPage(
        (deployment.publicAccessMode === "builtin-frp"
          ? !document.getElementById("frpc-content").value.trim()
          : deployment.publicAccessMode === "external-reverse-proxy"
            ? !document.getElementById("public-origin").value.trim()
            : false)
          ? "guide"
          : "overview",
        undefined,
        true,
      );
  }
  renderSetup();
  setText($("connections-result"), s.deploymentMessage || deployment.credentialsError || "");
  setText($("ports-result"), portsValidationError || s.portsMessage || "");
  renderControls();
  for (const [id, key] of [
    ["app-id-path", "credentials"],
    ["secret-hint", "credentials"],
    ["frpc-hint", "frpc"],
  ])
    setText($(id), deployment.paths?.[key] ? "保存位置：" + deployment.paths[key] : "");
  const serviceNames =
    deployment.publicAccessMode === "local"
      ? ["DevBoard 后端"]
      : deployment.publicAccessMode === "external-reverse-proxy"
        ? ["DevBoard 后端", "Caddy"]
        : names;
  renderList(
    document.getElementById("services"),
    serviceNames.map((name) => s.services?.find((x) => x.name === name)?.status || "stopped"),
    () =>
      serviceNames.map((name) => {
        const st = s.services?.find((x) => x.name === name)?.status || "stopped";
        const row = document.createElement("div");
        row.className = "service";
        const label = document.createElement("span");
        label.textContent = name;
        const status = document.createElement("small");
        status.className = st;
        status.textContent =
          st === "running"
            ? "运行中"
            : st === "ready"
              ? "已连接"
              : st === "stopped"
                ? "未运行"
                : "等待连接";
        row.append(label, status);
        return row;
      }),
  );
  const logs = (s.logs || []).slice().reverse();
  renderList($("log-list"), logs, () => {
    if (!logs.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "暂无运行日志";
      return [empty];
    }
    return logs.map((l) => {
      const row = document.createElement("div");
      row.className = "log-row";
      const t = document.createElement("small");
      t.textContent = l.time;
      const c = document.createElement("strong");
      c.textContent = l.component;
      row.append(t, c, document.createTextNode(l.message));
      return row;
    });
  });
}
function acknowledgeFields(ids) {
  for (const id of ids) {
    if (submittedFields.get(id) === $(id).value) dirtyFields.delete(id);
    submittedFields.delete(id);
  }
}
function renderControls() {
  const s = snapshot;
  const active = ["starting", "ready", "stopping"].includes(s.phase);
  const transitioning = s.phase === "stopping";
  const saving = Boolean(s.deploymentSaving || s.portsSaving);
  const busy = pending || saving || transitioning;
  $("start").disabled = active || busy;
  $("stop").disabled = !active || busy;
  for (const id of [
    ...connectionFields,
    ...portFields.map(([id]) => id),
    "save-connections",
    "save-ports",
    "show-secret",
    "restart-service",
    "restart-now",
  ])
    $(id).disabled = busy;
  $("restart-later").disabled = pending;
  setText($("save-connections"), s.deploymentSaving ? "正在保存…" : "保存配置");
  setText($("save-ports"), s.portsSaving ? "正在保存…" : "保存端口");
  $("restart-notice").hidden = !s.restartRequired;
  if (!s.restartRequired) {
    restartPromptPending = false;
    if ($("restart-dialog").open) $("restart-dialog").close();
  } else if (restartPromptPending && !busy && !$("restart-dialog").open) {
    $("restart-dialog").showModal();
  }
  renderSetup();
}
async function poll() {
  try {
    if (invoke) render(await invoke("snapshot"));
    else
      render({
        phase: "stopped",
        message: "界面预览 · 请在 DevBoard 应用中启动服务",
        services: [],
        logs: [],
      });
  } catch (e) {
    setText($("error"), "无法读取状态：" + e);
  }
  setTimeout(poll, 1000);
}
$("web-open-board").onclick = () => action("control", { action: "open_web_board" });
let webAccountsRevision = -1;
let resettingWebAccount = null;
$("web-account-form").onsubmit = async (event) => {
  event.preventDefault();
  const password = $("web-password").value;
  $("web-password").value = "";
  await action("control", {
    action: "web_accounts",
    settings: {
      operation: "create",
      username: $("web-username").value,
      name: $("web-name").value,
      password,
    },
  });
};
$("web-accounts-refresh").onclick = () =>
  action("control", { action: "web_accounts", settings: { operation: "list" } });
$("web-reset-cancel").onclick = () => {
  $("web-account-reset").hidden = true;
  $("web-reset-password").value = "";
  resettingWebAccount = null;
};
$("web-account-reset").onsubmit = async (event) => {
  event.preventDefault();
  const id = resettingWebAccount;
  const password = $("web-reset-password").value;
  $("web-reset-password").value = "";
  $("web-account-reset").hidden = true;
  resettingWebAccount = null;
  if (id)
    await action("control", {
      action: "web_accounts",
      settings: { operation: "update", id, password },
    });
};
function renderWebAccounts(s) {
  $("web-accounts-message").textContent = s.webAccountsMessage || "启动服务后刷新账号列表。";
  $("web-account-create").disabled = Boolean(s.webAccountsBusy);
  $("web-accounts-refresh").disabled = Boolean(s.webAccountsBusy);
  if (webAccountsRevision === s.webAccountsRevision) return;
  webAccountsRevision = s.webAccountsRevision;
  $("web-accounts-list").replaceChildren();
  for (const account of s.webAccounts || []) {
    const row = document.createElement("div");
    row.className = "web-account-row";
    const label = document.createElement("span");
    label.textContent = `${account.name} (${account.username}) · ${account.active ? "已启用" : "已停用"}`;
    const toggle = document.createElement("button");
    toggle.textContent = account.active ? "停用并退出登录" : "启用";
    toggle.onclick = () =>
      action("control", {
        action: "web_accounts",
        settings: { operation: "update", id: account.id, active: !account.active },
      });
    const reset = document.createElement("button");
    reset.textContent = "重置密码";
    reset.onclick = () => {
      resettingWebAccount = account.id;
      $("web-account-reset").hidden = false;
      $("web-reset-password").focus();
    };
    row.append(label, toggle, reset);
    $("web-accounts-list").append(row);
  }
}

poll();
