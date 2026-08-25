// Rich-text clipboard: copy the rendered HTML so pasting into Word / WeChat /
// email keeps formatting. Two MIMEs in one ClipboardItem (some consumers reject
// items lacking text/plain), and `juice` inlines the theme CSS so WeChat —
// which strips external stylesheets — preserves the look.
//
// juice is imported lazily so its weight stays off the initial bundle: it's
// only needed for the "copy rich text" action.

import { tracedIo } from "./ipcTrace";

/**
 * Copy rendered HTML + plain-text fallback to the clipboard.
 * Must be called from a user gesture (click/keydown) — the webview enforces
 * this like a normal browser.
 */
export async function copyRich(html: string, plain: string, css: string): Promise<void> {
  await tracedIo("ipc:clipboard", "copyRich:富文本复制", async () => {
    // juice v12 exposes inlineContent (not `inline`).
    const juice = (await import("juice")).default;
    const inlined = juice.inlineContent(html, css);
    const htmlBlob = new Blob([inlined], { type: "text/html" });
    const textBlob = new Blob([plain], { type: "text/plain" });
    // Some webviews reject the same Blob used twice; build two.
    const item = new ClipboardItem({
      "text/html": htmlBlob,
      "text/plain": textBlob,
    });
    await navigator.clipboard.write([item]);
  });
}

/** Plain-text copy helper. */
export async function copyText(text: string): Promise<void> {
  await tracedIo("ipc:clipboard", "copyText:纯文本复制", () =>
    navigator.clipboard.writeText(text)
  );
}
