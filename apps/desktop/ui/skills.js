/* global dirtyFields */
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  const element = (id) => document.getElementById(id);
  let state = null;
  let busy = false;
  let error = "";
  let readingFailed = false;
  let offered = false;
  let generation = 0;
  let readSequence = 0;
  let replaceFingerprint = null;
  let dismissedUpdate = null;
  let timer;

  function text(id, value) {
    const target = element(id);
    const next = String(value ?? "");
    if (target.textContent !== next) target.textContent = next;
  }

  function message(id, value) {
    text(id, value);
    element(id).hidden = !value;
  }

  function blocked() {
    return busy || readingFailed || Boolean(window.larkAppUpdateInstalling);
  }

  function render() {
    const labels = {
      notInstalled: "尚未安装配套 Skill。",
      current: "Skill 文件已安装，无需更新。",
      updateAvailable: "有新版 Skill，可以更新。",
      modified: "现有 Skill 包含修改，需要你决定如何处理。",
      managed: "已有 Skill 或安装位置由其他方式管理。",
      error: "Skill 操作未完成。",
      unavailable: "当前无法安装配套 Skill。",
    };
    text("skill-status", busy ? "正在处理 Skill…" : (labels[state?.status] ?? "正在检查 Skill…"));
    text(
      "skill-version",
      state?.bundledVersion
        ? `随包版本 ${state.bundledVersion}${state.installedVersion ? ` · 已安装 ${state.installedVersion}` : ""}`
        : "",
    );
    text("skill-path", state?.targetPath);
    text("skill-message", state?.message);
    message("skill-error", error);
    element("skill-refresh").disabled = busy || !invoke;
    element("skill-install").hidden = !state?.canInstall;
    element("skill-install").disabled = blocked();
    text("skill-install", state?.status === "updateAvailable" ? "更新 Skill" : "安装到 Codex");
    element("skill-replace").hidden = !state?.canReplace;
    element("skill-replace").disabled = blocked();
    element("skill-offer-install").disabled = blocked() || !state?.canInstall;
    element("skill-offer-later").disabled = busy;
    element("skill-replace-confirm").disabled =
      blocked() || !state?.canReplace || state.fingerprint !== replaceFingerprint;
    element("skill-replace-cancel").disabled = busy;
    element("skill-notice").hidden =
      state?.status !== "updateAvailable" || dismissedUpdate === state?.bundledVersion;
    if (element("skill-replace-dialog").open && state?.fingerprint !== replaceFingerprint)
      message("skill-replace-error", "Skill 内容已变化，请关闭此窗口并重新检查后再决定。");
  }

  function accept(result) {
    if (!result || typeof result.status !== "string" || typeof result.canInstall !== "boolean")
      throw new Error("无法读取 Skill 状态，请重新检查。");
    state = result;
    readingFailed = false;
    if (state.status === "error") error = state.message || "操作失败，请重新检查后重试。";
    render();
  }

  function maybeOffer() {
    if (
      offered ||
      busy ||
      readingFailed ||
      state?.offerDismissed ||
      state?.status !== "notInstalled" ||
      !state?.canInstall ||
      window.larkAppUpdateInstalling
    )
      return;
    if (
      document.querySelector("dialog[open]") ||
      (typeof dirtyFields !== "undefined" && dirtyFields.size > 0)
    )
      return;
    offered = true;
    element("skill-offer-dialog").showModal();
    element("skill-offer-later").focus();
  }

  function schedule(delay = 15000) {
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  }

  async function refresh() {
    if (!invoke) return;
    if (busy) return schedule();
    const requestGeneration = generation;
    const requestSequence = ++readSequence;
    try {
      const result = await invoke("skill_status");
      if (requestGeneration === generation && requestSequence === readSequence && !busy) {
        error = "";
        accept(result);
        maybeOffer();
      }
    } catch (cause) {
      if (requestGeneration === generation && requestSequence === readSequence && !busy) {
        readingFailed = true;
        error = String(cause);
        render();
      }
    } finally {
      schedule();
    }
  }

  async function install(replaceModified = false) {
    if (!invoke || blocked() || !(replaceModified ? state?.canReplace : state?.canInstall)) return;
    const fingerprint = replaceModified ? replaceFingerprint : state.fingerprint;
    if (!fingerprint || (replaceModified && fingerprint !== state.fingerprint)) return;
    busy = true;
    window.larkSkillInstallPending = true;
    generation++;
    error = "";
    message("skill-offer-error", "");
    message("skill-replace-error", "");
    render();
    try {
      accept(await invoke("install_skill", { expectedFingerprint: fingerprint, replaceModified }));
      if (state.status === "current") {
        element("skill-offer-dialog").close();
        element("skill-replace-dialog").close();
        document.querySelector('[data-tab="settings"]').click();
        element("skill-card").scrollIntoView({ block: "nearest" });
      }
    } catch (cause) {
      error = String(cause);
    } finally {
      busy = false;
      window.larkSkillInstallPending = false;
      if (error) {
        message("skill-offer-error", error);
        message("skill-replace-error", error);
      }
      render();
      schedule();
    }
  }

  async function deferOffer() {
    if (busy) return;
    offered = true;
    element("skill-offer-dialog").close();
    generation++;
    busy = true;
    render();
    try {
      accept(await invoke("dismiss_skill_offer"));
    } catch (cause) {
      error = String(cause);
    } finally {
      busy = false;
      render();
      schedule();
    }
  }

  element("skill-refresh").onclick = refresh;
  element("skill-install").onclick = () => install();
  element("skill-offer-install").onclick = () => install();
  element("skill-offer-later").onclick = deferOffer;
  element("skill-offer-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    void deferOffer();
  });
  element("skill-replace").onclick = () => {
    if (blocked() || !state?.canReplace) return;
    replaceFingerprint = state.fingerprint;
    message("skill-replace-error", "");
    element("skill-replace-dialog").showModal();
    element("skill-replace-cancel").focus();
    render();
  };
  element("skill-replace-confirm").onclick = () => install(true);
  element("skill-replace-cancel").onclick = () => element("skill-replace-dialog").close();
  element("skill-replace-dialog").addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  element("skill-notice-open").onclick = () => {
    document.querySelector('[data-tab="settings"]').click();
    element("skill-card").scrollIntoView({ block: "nearest" });
  };
  element("skill-notice-dismiss").onclick = () => {
    dismissedUpdate = state?.bundledVersion;
    render();
  };
  if (invoke) void refresh();
  else {
    state = {
      status: "unavailable",
      canInstall: false,
      canReplace: false,
      message: "请在 Lark-Codex 应用中安装配套 Skill。",
    };
    render();
  }
})();
