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

  it("无闪卡 → 原样返回", () => {
    const src = "<p>普通内容</p>";
    expect(degradeFlashcardsInHtml(src)).toBe(src);
  });
});
