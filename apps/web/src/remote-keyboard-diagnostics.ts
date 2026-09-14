import { uploadRemoteFile } from "./remote-api";

// Opt-in, bounded geometry trace. Never collect input values, text, URLs,
// thread ids, DOM markup, native file paths or authentication data.
export function installKeyboardDiagnostics(root: HTMLElement, csrf: string): () => void {
  if (new URLSearchParams(window.location.search).get("keyboardDebug") !== "1") return () => {};
  const records: unknown[] = [];
  const started = performance.now();
  let frame = 0;
  let remainingFrames = 0;
  const round = (value: number | undefined) =>
    value === undefined ? null : Math.round(value * 10) / 10;
  const category = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return "other";
    if (target.matches(".remote-search input")) return "search-input";
    if (target.closest(".remote-search")) return "search-label";
    if (target.matches(".remote-rich-composer textarea")) return "composer-input";
    return "other";
  };
  const sample = (event: string, target: EventTarget | null = null, prevented = false) => {
    const viewport = window.visualViewport;
    const bounds = root.getBoundingClientRect();
    records.push({
      t: round(performance.now() - started),
      event,
      target: category(target),
      prevented,
      active: category(document.activeElement),
      scrollY: round(window.scrollY),
      innerHeight: window.innerHeight,
      visualHeight: round(viewport?.height),
      visualTop: round(viewport?.offsetTop),
      pageTop: round(viewport?.pageTop),
      scale: round(viewport?.scale),
      rootTop: round(bounds.top),
      rootHeight: round(bounds.height),
      headerTop: round(root.querySelector(".remote-header")?.getBoundingClientRect().top),
      parentTop: round(root.parentElement?.getBoundingClientRect().top),
      cssTop: root.style.getPropertyValue("--remote-top"),
    });
    if (records.length > 300) records.shift();
  };
  const tick = () => {
    sample("frame");
    if (--remainingFrames > 0) frame = requestAnimationFrame(tick);
    else frame = 0;
  };
  const onEvent = (event: Event) => {
    sample(event.type, event.target, event.defaultPrevented);
    remainingFrames = 40;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const events = ["touchstart", "touchend", "focusin", "focusout"] as const;
  for (const event of events) root.addEventListener(event, onEvent);
  window.addEventListener("scroll", onEvent);
  window.visualViewport?.addEventListener("resize", onEvent);
  window.visualViewport?.addEventListener("scroll", onEvent);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "保存键盘诊断";
  button.style.cssText =
    "position:fixed;right:12px;top:100px;z-index:10000;padding:10px;border:1px solid #ddd;border-radius:12px;background:white;color:#222;font-size:14px";
  const controller = new AbortController();
  button.onclick = async () => {
    button.disabled = true;
    const data = JSON.stringify({ version: "keyboard-label-v1", records: records.slice() });
    button.textContent = "正在保存诊断…";
    try {
      await uploadRemoteFile(
        new File([data], "keyboard-diagnostics.json", { type: "application/json" }),
        csrf,
        () => {},
        controller.signal,
      );
      button.textContent = "诊断已保存";
    } catch {
      if (!controller.signal.aborted) {
        button.textContent = "保存失败，点击重试";
        button.disabled = false;
      }
    }
  };
  root.append(button);
  sample("start");
  return () => {
    controller.abort();
    cancelAnimationFrame(frame);
    button.remove();
    for (const event of events) root.removeEventListener(event, onEvent);
    window.removeEventListener("scroll", onEvent);
    window.visualViewport?.removeEventListener("resize", onEvent);
    window.visualViewport?.removeEventListener("scroll", onEvent);
  };
}
