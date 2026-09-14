/* global dirtyFields, pending, snapshot */
(() => {
  const invokeUpdate = window.__TAURI__?.core?.invoke;
  const element = (id) => document.getElementById(id);
  const activeStates = new Set(["checking", "downloading", "installing"]);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  let state = { status: "idle", currentVersion: "", canInstall: false };
  let requestPending = "";
  let requestGeneration = 0;
  let lastAutomaticRequest = null;
  let dismissedNotice = "";
  let transportError = "";
  let stateReadFailed = false;
  let pollTimer;

  function text(id, value) {
    const target = element(id);
    const valueText = String(value ?? "");
    if (target.textContent !== valueText) target.textContent = valueText;
  }

  function installBlockReason() {
    // app.js owns the editors; installing must not discard an unsaved form.
    if (typeof dirtyFields !== "undefined" && dirtyFields.size > 0)
      return "连接配置或端口仍有未保存的修改，请先保存后再安装。";
    if (
      (typeof pending !== "undefined" && pending) ||
      (typeof snapshot !== "undefined" &&
        (snapshot.deploymentSaving || snapshot.portsSaving || snapshot.phase === "stopping"))
    )
      return "正在处理本机服务或保存配置，请完成后再安装。";
    return "";
  }

  function mayInstall() {
    return state.canInstall && ["ready", "error"].includes(state.status);
  }

  function bytes(value) {
    const amount = Math.max(0, Number(value) || 0);
    return amount < 1024 * 1024
      ? `${Math.round(amount / 1024)} KB`
      : `${(amount / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderUpdate() {
    const installing = state.status === "installing" || requestPending === "install_update";
    const busy = Boolean(requestPending) || activeStates.has(state.status);
    const version = state.version ? ` ${state.version}` : "";
    const statuses = {
      idle: "每天在后台检查一次更新。",
      checking: "正在检查更新…",
      available: `发现新版本${version}，可下载后选择安装时间。`,
      downloading: `正在下载新版本${version}…`,
      ready: `新版本${version}已下载并通过校验，可以安装。`,
      installing: "正在安装更新，应用即将重启…",
      error: "更新未完成，请按下方提示重试。",
      upToDate: "当前已是最新版本。",
    };
    text("update-status", statuses[state.status] ?? "正在读取更新状态…");
    if (state.currentVersion) {
      text("update-current-version", `当前版本 ${state.currentVersion}`);
    }
    const checked = Number(state.lastChecked);
    text(
      "update-last-checked",
      checked > 0 && Number.isFinite(checked)
        ? `上次检查：${new Date(checked).toLocaleString("zh-CN")}`
        : "每天在后台检查一次，也可以手动检查。",
    );
    text(
      "update-check",
      state.status === "checking" || requestPending === "check_updates" ? "正在检查…" : "检查更新",
    );
    element("update-check").disabled = !invokeUpdate || busy;
    element("update-download").hidden = !(
      state.status === "available" ||
      (state.status === "error" && state.version && !state.canInstall)
    );
    element("update-download").disabled = busy || stateReadFailed;
    text("update-download", state.status === "error" ? "重新下载" : "下载更新");
    element("update-install").hidden = !mayInstall() && !installing;
    element("update-install").disabled = busy || stateReadFailed || Boolean(installBlockReason());
    text("update-install", installing ? "正在安装…" : "安装并重启");
    element("update-install-hint").hidden = !mayInstall() && !installing;
    text(
      "update-install-hint",
      installBlockReason() ||
        "安装时将停止本机服务，重启后恢复。请先结束正在执行的任务并保存配置。",
    );

    const downloading = state.status === "downloading";
    element("update-download-progress").hidden = !downloading;
    const total = Number(state.totalBytes);
    const downloaded = Math.max(0, Number(state.downloadedBytes) || 0);
    if (total > 0 && Number.isFinite(total)) {
      element("update-progress").value = Math.min(100, (downloaded / total) * 100);
      text("update-progress-text", `${bytes(downloaded)} / ${bytes(total)}`);
    } else {
      element("update-progress").removeAttribute("value");
      text("update-progress-text", `已下载 ${bytes(downloaded)}`);
    }
    element("update-release-notes").hidden = !state.notes;
    // Release notes remain plain text; a release cannot inject HTML or navigation.
    text("update-notes", state.notes);
    const error = transportError || state.error || "";
    element("update-error").hidden = !error;
    text("update-error", error);
    if (element("update-dialog").open) {
      const dialogError = error || installBlockReason();
      element("update-dialog-error").hidden = !dialogError;
      text("update-dialog-error", dialogError);
    }
    element("update-confirm").disabled =
      busy || stateReadFailed || !mayInstall() || Boolean(installBlockReason());
    element("update-cancel").disabled = installing;
    text("update-confirm", installing ? "正在安装…" : "安装并重启");

    const notify = ["available", "ready"].includes(state.status);
    const noticeKey = `${state.version}:${state.status}`;
    element("update-notice").hidden = !notify || noticeKey === dismissedNotice;
    if (notify)
      text(
        "update-notice-text",
        state.status === "ready"
          ? `新版本${version}已准备好安装。`
          : `发现 Lark-Codex 新版本${version}。`,
      );
  }

  function acceptStatus(result) {
    if (!result || typeof result.status !== "string")
      throw new Error("无法读取更新状态，请稍后重试。");
    if (stateReadFailed) transportError = "";
    state = result;
    stateReadFailed = false;
    renderUpdate();
  }

  async function runUpdateCommand(command, args = {}) {
    if (!invokeUpdate || requestPending || activeStates.has(state.status)) return;
    if (command === "install_update" && (!mayInstall() || installBlockReason())) return;
    const generation = ++requestGeneration;
    requestPending = command;
    transportError = "";
    renderUpdate();
    try {
      const result = await invokeUpdate(command, args);
      if (generation === requestGeneration) acceptStatus(result);
    } catch (error) {
      transportError = String(error);
    } finally {
      requestPending = "";
      renderUpdate();
      schedulePoll(750);
    }
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollUpdates, delay);
  }

  async function pollUpdates() {
    const generation = requestGeneration;
    try {
      const result = await invokeUpdate("update_status");
      // Ignore a status read started before a newer user action.
      if (generation === requestGeneration && !requestPending) acceptStatus(result);
    } catch {
      if (generation === requestGeneration) {
        stateReadFailed = true;
        transportError = "无法读取更新状态，稍后会自动重试；也可以点击检查更新。";
        renderUpdate();
      }
    }
    const now = Date.now();
    if (
      !stateReadFailed &&
      !requestPending &&
      ["idle", "upToDate", "available", "error"].includes(state.status) &&
      !state.canInstall &&
      (lastAutomaticRequest === null ||
        now < lastAutomaticRequest ||
        now - lastAutomaticRequest >= hour) &&
      (!state.lastChecked ||
        now < Number(state.lastChecked) ||
        now - Number(state.lastChecked) >= day)
    ) {
      lastAutomaticRequest = now;
      // The native updater persists its own daily throttle across app restarts.
      void runUpdateCommand("check_updates", { automatic: true });
    }
    schedulePoll(activeStates.has(state.status) || requestPending ? 750 : 15000);
  }

  element("update-check").onclick = () => runUpdateCommand("check_updates", { automatic: false });
  element("update-download").onclick = () => runUpdateCommand("download_update");
  element("update-install").onclick = () => {
    if (!mayInstall() || requestPending || stateReadFailed) return;
    renderUpdate();
    element("update-dialog").showModal();
    renderUpdate();
  };
  element("update-confirm").onclick = () => {
    if (element("update-dialog").open) return runUpdateCommand("install_update");
  };
  element("update-cancel").onclick = () => {
    if (!element("update-cancel").disabled) element("update-dialog").close();
  };
  element("update-dialog").oncancel = (event) => {
    if (state.status === "installing" || requestPending === "install_update")
      event.preventDefault();
  };
  element("update-dialog").onkeydown = (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const buttons = [element("update-cancel"), element("update-confirm")].filter(
      (button) => !button.disabled,
    );
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
  element("update-notice-open").onclick = () => {
    document.querySelector('[data-tab="settings"]').click();
    element("update-card").scrollIntoView({ block: "nearest" });
    element("update-check").focus();
  };
  element("update-notice-dismiss").onclick = () => {
    dismissedNotice = `${state.version}:${state.status}`;
    renderUpdate();
  };
  document.addEventListener("input", renderUpdate);
  renderUpdate();
  if (invokeUpdate) void pollUpdates();
  else {
    text("update-current-version", "请在 Lark-Codex 应用中检查更新");
    text("update-status", "界面预览不检查或安装更新。");
  }
})();
