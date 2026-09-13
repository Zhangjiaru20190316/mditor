import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./renderMarkdown";

// 静态管线本地图片解析（v4.12.2）：renderMarkdown 的 docPath 选项把 markdown
// 里的本地图片引用（相对路径 / raw HTML <img>）重写为可渲染 URL——与编辑器
// proxyDomURL → resolveImgSrc 同一份语义。此前静态表面（批注弹窗等）原样输出
// 相对 src，webview 无 base URL 必裂。协议白名单（asset:/mditor-asset: 等）
// 也在此锁定——sanitize 比 CSP 更紧会把合法图砍成无 src 的空图。

const { calls, adapter } = vi.hoisted(() => {
  const calls: string[] = [];
  const adapter = {
    app: {
      convertFileSrc: (p: string) => {
        calls.push(p);
        return `asset://${encodeURIComponent(p)}`;
      },
    },
  };
  return { calls, adapter };
});

vi.mock("../platform", () => ({
  getAdapter: () => adapter,
}));

function imgSrcs(html: string): string[] {
  return [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) =>
    decodeURIComponent(m[1])
  );
}

beforeEach(() => {
  calls.length = 0;
});

describe("renderMarkdown docPath 本地图片重写", () => {
  it("相对引用按文档目录解析并经 convertFileSrc", async () => {
    const html = await renderMarkdown("![图](assets/fig.png)", {
      docPath: "E:/笔记/doc.md",
    });
    expect(imgSrcs(html)).toEqual(["asset://E:/笔记/assets/fig.png"]);
    expect(calls).toEqual(["E:/笔记/assets/fig.png"]);
  });

  it("raw HTML <img> 同样重写（rehypeRaw 之后）", async () => {
    const html = await renderMarkdown('<img src="assets/pic.png" alt="a">', {
      docPath: "E:/notes/a.md",
    });
    expect(imgSrcs(html)).toEqual(["asset://E:/notes/assets/pic.png"]);
  });

  it("http/data 引用不进 convertFileSrc", async () => {
    const html = await renderMarkdown(
      "![a](https://x.test/a.png) ![b](data:image/png;base64,AAA)",
      { docPath: "E:/notes/a.md" }
    );
    expect(calls).toEqual([]);
    expect(imgSrcs(html)).toEqual([
      "https://x.test/a.png",
      "data:image/png;base64,AAA",
    ]);
  });

  it("不传 docPath：行为与旧版一致（相对 src 原样、不碰适配器）", async () => {
    const html = await renderMarkdown("![图](assets/fig.png)");
    expect(imgSrcs(html)).toEqual(["assets/fig.png"]);
    expect(calls).toEqual([]);
  });

  it("asset:/mditor-asset: 协议 URL 通过 sanitize（白名单与 CSP 对齐）", async () => {
    const html = await renderMarkdown(
      "![a](asset://x) ![b](mditor-asset://y) ![c](blob:z)",
      { docPath: "E:/n/a.md" }
    );
    // blob: 不是本地文件形态，resolveImgSrc 直通；三者都不应被 sanitize 砍掉。
    expect(imgSrcs(html)).toEqual(["asset://x", "mditor-asset://y", "blob:z"]);
  });

  it("同一内容不同 docPath 缓存不串（渲染结果随文档目录变化）", async () => {
    const md = "![图](assets/fig.png)";
    const h1 = await renderMarkdown(md, { docPath: "E:/a/x.md" });
    const h2 = await renderMarkdown(md, { docPath: "E:/b/x.md" });
    expect(imgSrcs(h1)).toEqual(["asset://E:/a/assets/fig.png"]);
    expect(imgSrcs(h2)).toEqual(["asset://E:/b/assets/fig.png"]);
    // 无 docPath 的调用不吃 docPath 缓存（反之亦然）。
    const h3 = await renderMarkdown(md);
    expect(imgSrcs(h3)).toEqual(["assets/fig.png"]);
  });
});
