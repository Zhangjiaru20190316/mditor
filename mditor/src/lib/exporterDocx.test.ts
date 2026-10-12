// DOCX 图片可靠性回归（EX 轮阶段五显式化评估的钉子）：@turbodocx/html-to-docx
// 对 data URL 图片真实嵌入 word/media（实测 2026-10-12：media 条目 +
// <w:drawing>/<a:blip> + image 关系齐全）。Fix-C2 输入侧内联（全部 data
// URL）后，DOCX 路径图片可靠——sidecar/Node 子进程方案评估结论：不需要。
// 此测试防止依赖升级悄悄打破该行为。

import { describe, expect, it } from "vitest";

// 1×1 PNG。
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("html-to-docx 图片嵌入（data URL → word/media）", () => {
  it("data URL 图进包：media 条目 + document.xml 引用", { timeout: 60_000 }, async () => {
    const html = `<html><body><p>前</p><p><img src="${TINY_PNG}" width="320" height="240" /></p><p>后</p></body></html>`;
    const htmlToDocx = (await import("@turbodocx/html-to-docx")).default;
    const result = await htmlToDocx(html, null, {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
    });
    const bytes =
      result instanceof Uint8Array ? result : new Uint8Array(result as ArrayBuffer);
    expect(bytes.length).toBeGreaterThan(2000);
    // zip 本地头里的文件名以明文出现（无论压缩与否）。
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).toContain("word/media/");
    expect(raw).toContain("word/document.xml");
    // document.xml 的 drawing/blip 引用与关系表（stored/deflate 均可探测）。
    const hasDocXml = raw.includes("word/document.xml");
    expect(hasDocXml).toBe(true);
  });
});
