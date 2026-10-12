// @vitest-environment jsdom
// 离屏渲染工厂（EX 轮阶段二基建）单测：文档组装纯函数 + 资源就绪组合器。
// renderInFactory 本体依赖真实 iframe 布局（jsdom 不做布局），由 dev 实例
// CDP 脚本端到端验收（perf/ex3-*）。

import { describe, expect, it, vi } from "vitest";
import {
  awaitFactoryResources,
  buildFactoryDocumentHtml,
  type ResourceImageLike,
} from "./exportRenderFactory";

function fakeImage(src: string, complete: boolean): ResourceImageLike {
  const listeners = new Map<string, (() => void)[]>();
  return {
    src,
    complete,
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    // 测试驱动用：手动触发 load/error。
    fire(type: "load" | "error") {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  } as ResourceImageLike & { fire(t: "load" | "error"): void };
}

describe("buildFactoryDocumentHtml", () => {
  it("真实版心宽度 + data-theme 回写（主题 CSS 变量的挂载点）", () => {
    const out = buildFactoryDocumentHtml("<p>hi</p>", {
      contentWidthPx: 680,
      css: "p{color:red}",
      theme: "dark",
    });
    expect(out).toContain('<html lang="zh-CN" data-theme="dark">');
    expect(out).toContain("#mditor-export-content { width: 680px; }");
    expect(out).toContain("body { width: 680px; }");
    expect(out).toContain("p{color:red}");
    expect(out).toContain('<div id="mditor-export-content">');
  });

  it("S10：输入先消毒（script/on* 不进工厂文档）", () => {
    const evil =
      '<p onclick="x()">a</p><script>alert(1)</script><img src="javascript:alert(2)">';
    const out = buildFactoryDocumentHtml(evil, {
      contentWidthPx: 680,
      css: "",
    });
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain('src="javascript:');
  });

  it("lazy/async 解码改即刻（离屏 iframe 视口外的 lazy 图永不加载）", () => {
    const html =
      '<img src="a.png" loading="lazy" decoding="async"><img src="b.png">';
    const out = buildFactoryDocumentHtml(html, { contentWidthPx: 680, css: "" });
    expect(out).not.toContain("loading=");
    expect(out).not.toContain('decoding="async"');
    expect(out).toContain('src="a.png"');
  });

  it("maxImageHeightPx 存在时输出单图高度钳制规则（分页护栏）", () => {
    const withClamp = buildFactoryDocumentHtml("<p>x</p>", {
      contentWidthPx: 680,
      css: "",
      maxImageHeightPx: 1000,
    });
    expect(withClamp).toContain("max-height: 1000px");
    const without = buildFactoryDocumentHtml("<p>x</p>", {
      contentWidthPx: 680,
      css: "",
    });
    expect(without).not.toContain("max-height");
  });

  it("标题做属性转义（不逃出 <title>）", () => {
    const out = buildFactoryDocumentHtml("<p>x</p>", {
      contentWidthPx: 680,
      css: "",
      title: 'a"b<c',
    });
    expect(out).not.toContain('a"b<c</title>');
    expect(out).toContain("a&quot;b&lt;c");
  });
});

describe("awaitFactoryResources（RC-3 确定性就绪）", () => {
  it("全部已就绪：立即完成，无 issue", async () => {
    const r = await awaitFactoryResources([
      fakeImage("a", true),
      fakeImage("b", true),
    ]);
    expect(r).toEqual({ issues: [], timedOut: false });
  });

  it("慢图 load 后完成；错误图显式入清单", async () => {
    const slow = fakeImage("slow.png", false);
    const bad = fakeImage("bad.png", false);
    const p = awaitFactoryResources([slow, bad]);
    bad.fire("error");
    slow.fire("load");
    const r = await p;
    expect(r.issues).toEqual([{ kind: "image-error", src: "bad.png" }]);
    expect(r.timedOut).toBe(false);
  });

  it("挂起图触发超时：未就绪项显式列报而非盲等致死", async () => {
    vi.useFakeTimers();
    const hung = fakeImage("hung.png", false);
    const p = awaitFactoryResources([hung], { readyTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.issues).toEqual([{ kind: "image-timeout", src: "hung.png" }]);
    vi.useRealTimers();
  });

  it("进度回调随 done 递增", async () => {
    const a = fakeImage("a", false);
    const b = fakeImage("b", false);
    const seen: string[] = [];
    const p = awaitFactoryResources([a, b], {
      onProgress: (d, t) => seen.push(`${d}/${t}`),
    });
    a.fire("load");
    b.fire("load");
    await p;
    expect(seen[0]).toBe("0/2");
    expect(seen[seen.length - 1]).toBe("2/2");
  });

  it("fontsReady 在图片之后才 resolve 也被等待", async () => {
    let releaseFonts: () => void = () => {};
    const fonts = new Promise<void>((res) => (releaseFonts = res));
    const img = fakeImage("a", false);
    const p = awaitFactoryResources([img], { fontsReady: fonts });
    img.fire("load");
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // 字体未就绪不得提前完成
    releaseFonts();
    await expect(p).resolves.toEqual({ issues: [], timedOut: false });
  });
});
