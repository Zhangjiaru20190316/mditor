// @vitest-environment jsdom
// DX 根因回归（2026-10-15 定罪，证据 perf/results/ex-dx-phase1-conviction.md）：
// @turbodocx/html-to-docx 的 browser 构建（exports.browser 条件——webview
// 实际加载的那份）裸引用 Node 全局 Buffer/global，WebView2 里任何文档导出
// DOCX 必抛 ReferenceError（含图档崩 yM 的 Buffer、纯文本档崩尾段 global）。
// vitest 默认走 exports.node（Node 构建）+ node 全局齐全，1077 绿测不出——
// 故本文件用 jsdom + 显式删全局模拟 webview，直驱 browser 构建钉住根因。
//
// 修复本体：exporter.ts ensureBrowserNodeGlobals()（global 别名 + MiniBuffer
// 垫片，仅补缺不覆盖）。exporterDocx.test.ts 的 node 构建钉子与本文件互补，
// 两份构建都被覆盖后才算「webview 可用」有回归防线。

import { describe, expect, it } from "vitest";
// browser 构建的类型声明见 src/turbodocx-browser-build.d.ts（untyped ESM
// 不能在模块文件内 augment）。

// 1×1 PNG（与 exporterDocx.test.ts 同款，钉 data URL 图嵌入契约）。
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 浏览器式全局模拟：删掉 Buffer/global（裸标识符 ReferenceError 语义），
 * 用完恢复（vitest worker 内文件串行，窗口期无其他文件共享本全局）。 */
function withoutNodeGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { Buffer?: unknown; global?: unknown };
  const hadB = "Buffer" in g;
  const hadG = "global" in g;
  const sB = g.Buffer;
  const sG = g.global;
  delete g.Buffer;
  delete g.global;
  return fn().finally(() => {
    if (hadB) g.Buffer = sB;
    else delete g.Buffer;
    if (hadG) g.global = sG;
    else delete g.global;
  });
}

describe("DOCX browser 构建垫片（DX 根因回归）", () => {
  it("垫片语义：缺则补齐、幂等、不覆盖已有实现", async () => {
    const { ensureBrowserNodeGlobals } = await import("./exporter");
    const g = globalThis as { Buffer?: unknown; global?: unknown };
    const realBuffer = g.Buffer;
    // node/jsdom 混合环境两者皆在 → 不覆盖。
    ensureBrowserNodeGlobals();
    expect(g.Buffer).toBe(realBuffer);
    expect(g.global).toBe(globalThis);
    // 置 undefined（webview「缺失」等价形态）→ 补齐。
    g.Buffer = undefined;
    g.global = undefined;
    try {
      ensureBrowserNodeGlobals();
      expect(typeof g.Buffer).toBe("function");
      expect(g.global).toBe(globalThis);
    } finally {
      g.Buffer = realBuffer;
      g.global = globalThis;
    }
  });

  it(
    "浏览器式全局（无 Buffer/global）下 browser 构建出包：data URL 图真实嵌入 word/media",
    { timeout: 60_000 },
    async () => {
      await withoutNodeGlobals(async () => {
        const { ensureBrowserNodeGlobals } = await import("./exporter");
        ensureBrowserNodeGlobals(); // 修复本体：不注入则 browser 构建必抛（根因）
        // 显式加载 browser 构建——webview 同款。
        const htmlToDocx = (
          await import("@turbodocx/html-to-docx/dist/html-to-docx.browser.esm.js")
        ).default;
        const html = `<html><body><p>前</p><p><img src="${TINY_PNG}" width="320" height="240" /></p><p>后</p></body></html>`;
        const result = await htmlToDocx(html, null, {
          table: { row: { cantSplit: true } },
          footer: true,
          pageNumber: true,
        });
        const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
        expect(bytes.length).toBeGreaterThan(2000);
        const raw = new TextDecoder("latin1").decode(bytes);
        expect(raw).toContain("word/media/");
        expect(raw).toContain("word/document.xml");
      });
    }
  );

  it(
    "纯文本文档（无图）同样出包——尾段 global 崩路径回归",
    { timeout: 60_000 },
    async () => {
      await withoutNodeGlobals(async () => {
        const { ensureBrowserNodeGlobals } = await import("./exporter");
        ensureBrowserNodeGlobals();
        const htmlToDocx = (
          await import("@turbodocx/html-to-docx/dist/html-to-docx.browser.esm.js")
        ).default;
        const result = await htmlToDocx(
          "<html><body><p>DX 回归：纯文本段落。</p></body></html>",
          null,
          { footer: true, pageNumber: true }
        );
        const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
        expect(bytes.length).toBeGreaterThan(2000);
        expect(new TextDecoder("latin1").decode(bytes)).toContain("word/document.xml");
      });
    }
  );
});
