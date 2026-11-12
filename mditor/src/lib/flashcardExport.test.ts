// 闪卡 HTML 导出降级测试（模块 4）：卡片容器 div → blockquote（嵌套 div
// 深度配对不误伤；无闪卡零开销）。

import { describe, expect, it } from "vitest";
import { degradeFlashcardsInHtml } from "./flashcardExport";

describe("degradeFlashcardsInHtml", () => {
  it("卡片容器 → blockquote，内部内容原样保留", () => {
    const html = `<p>前文</p><div class="md-flashcard" data-flashcard="1"><p>问题？</p><hr><p>答案。</p></div><p>后文</p>`;
    const out = degradeFlashcardsInHtml(html);
    expect(out).toContain("<blockquote class=\"md-flashcard\">");
    expect(out).not.toContain("data-flashcard");
    expect(out).toContain("<p>问题？</p>");
    expect(out).toContain("<p>答案。</p>");
    expect(out).toContain("<p>前文</p>");
    expect(out).toContain("<p>后文</p>");
  });

  it("嵌套 div（KaTeX / 自定义容器）配对正确", () => {
    const html = `<div class="md-flashcard" data-flashcard="1"><div class="outer"><div class="inner">x</div></div><p>Q</p></div><p>尾</p>`;
    const out = degradeFlashcardsInHtml(html);
    expect(out).toContain('<div class="outer"><div class="inner">x</div></div>');
    expect(out.endsWith("<p>尾</p>")).toBe(true);
    expect(out).not.toContain("data-flashcard");
  });

  it("多张卡独立降级", () => {
    const html = `<div class="md-flashcard" data-flashcard="1"><p>1</p></div><p>中</p><div class="md-flashcard" data-flashcard="1"><p>2</p></div>`;
    const out = degradeFlashcardsInHtml(html);
    expect((out.match(/<blockquote class="md-flashcard">/g) ?? []).length).toBe(2);
    expect(out).toContain("<p>中</p>");
  });

  it("嵌套闪卡（MC 轮 P1）：内卡不重复输出、无孤立 </div>、外卡后半不重放", () => {
    // 旧缺陷形态：单趟遍历在内卡（start < last）上重入——内卡内容重复、
    // 外卡后半（<p>D</p>）重复输出且残留孤立 </div>。
    const html =
      `<p>A</p>` +
      `<div class="md-flashcard" data-flashcard="1">` +
      `<p>B</p>` +
      `<div class="md-flashcard" data-flashcard="1"><p>C</p></div>` +
      `<p>D</p>` +
      `</div>` +
      `<p>E</p>`;
    const out = degradeFlashcardsInHtml(html);
    // 内外都降级为 blockquote，各一次。
    expect((out.match(/<blockquote class="md-flashcard">/g) ?? []).length).toBe(2);
    expect(out).not.toContain("data-flashcard");
    expect(out).not.toContain("<div");
    // 内容零重复零丢失：B/C/D/E 各恰好一次，顺序保持。
    for (const frag of ["<p>A</p>", "<p>B</p>", "<p>C</p>", "<p>D</p>", "<p>E</p>"]) {
      expect((out.match(new RegExp(frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(1);
    }
    expect(out.indexOf("<p>B</p>")).toBeLessThan(out.indexOf("<p>C</p>"));
    expect(out.indexOf("<p>C</p>")).toBeLessThan(out.indexOf("<p>D</p>"));
  });

  it("无闪卡 → 原样返回", () => {
    const src = "<p>普通内容</p>";
    expect(degradeFlashcardsInHtml(src)).toBe(src);
  });
});
