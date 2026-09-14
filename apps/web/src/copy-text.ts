export const manualCopyGuidance = "浏览器在 HTTP 页面禁用了复制，请长按或选中文本手动复制。";

export type CopyTextResult =
  { readonly copied: true } | { readonly copied: false; guidance: string };

export async function copyText(value: string): Promise<CopyTextResult> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return { copied: true };
    } catch {
      // Insecure HTTP contexts can expose the API while rejecting writes; try the legacy path.
    }
  }

  if (
    typeof document !== "undefined" &&
    document.body &&
    typeof document.execCommand === "function"
  ) {
    let textarea: HTMLTextAreaElement | undefined;
    try {
      textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      if (document.execCommand("copy")) return { copied: true };
    } catch {
      // Fall through to visible manual-copy guidance.
    } finally {
      textarea?.remove();
    }
  }

  return { copied: false, guidance: manualCopyGuidance };
}
