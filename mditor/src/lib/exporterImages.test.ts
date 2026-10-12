// inlineExportImages（EX 轮 Fix-C2）的行为锚点：C2 显式报告面。
//
// 旧 inlineLocalImages 三重静默降级（超预算/嗅探失败/总预算耗尽）+ 远程图
// 永不内联，全部无报告——E-1 的直接根源（阶段一定罪 ex-phase1-e1e2）。
// 新 API 对文档内每张 <img> 给出显式结局（inlined/oversize/sniff-fail/
// budget/read-error/remote-*），未内联清单交给 UI 列报。本地换装语义与
// 旧函数逐字节一致（inlineLocalImages 退化为兼容包装，回归零）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inlineExportImages,
  INLINE_IMG_MAX_BYTES,
  formatMissingImages,
  markMissingImages,
  type ExportImageReportItem,
} from "./exporter";

// 最小合法 PNG（魔数 + IHDR 长度域的 16 字节即可过嗅探；内容无需真可解码）。
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
const GARBAGE = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11]);

const { adapter, fsCalls } = vi.hoisted(() => {
  const fsCalls: { op: string; path: string }[] = [];
  const files = new Map<string, Uint8Array>();
  const adapter = {
    fs: {
      readFile: async (p: string) => {
        fsCalls.push({ op: "read", path: p });
        const f = files.get(p);
        if (!f) throw new Error("not found: " + p);
        return f;
      },
    },
    app: {
      fetchImage: async (url: string) => {
        fsCalls.push({ op: "fetch", path: url });
        const u = files.get(url);
        if (!u) throw new Error("download failed");
        return u;
      },
    },
    __files: files,
  };
  return { adapter, fsCalls };
});

vi.mock("../platform", () => ({ getAdapter: () => adapter }));

const DOC = "C:/docs/note.md";
const img = (src: string) => `<p><img src="${src}" alt="a"></p>`;

beforeEach(() => {
  adapter.__files.clear();
  fsCalls.length = 0;
});

describe("inlineExportImages 本地图（语义与旧 inlineLocalImages 一致 + 显式结局）", () => {
  it("预算内本地图 → inlined + data URL 换装", async () => {
    adapter.__files.set("C:/docs/a.png", PNG);
    const r = await inlineExportImages(img("a.png"), DOC);
    expect(r.report).toEqual([
      { src: "a.png", status: "inlined", bytes: PNG.byteLength },
    ]);
    expect(r.missing).toEqual([]);
    expect(r.html).toContain('src="data:image/png;base64,');
    expect(r.html).not.toContain('src="a.png"');
  });

  it("超单图预算 → oversize，保留原引用", async () => {
    const big = new Uint8Array(INLINE_IMG_MAX_BYTES + 1);
    big.set(PNG.subarray(0, 8), 0);
    adapter.__files.set("C:/docs/big.png", big);
    const r = await inlineExportImages(img("big.png"), DOC);
    expect(r.report[0].status).toBe("oversize");
    expect(r.missing).toHaveLength(1);
    expect(r.html).toContain('src="big.png"');
  });

  it("魔数嗅探失败 → sniff-fail（.png 扩展名的垃圾字节不内联）", async () => {
    adapter.__files.set("C:/docs/fake.png", GARBAGE);
    const r = await inlineExportImages(img("fake.png"), DOC);
    expect(r.report[0].status).toBe("sniff-fail");
    expect(r.html).toContain('src="fake.png"');
  });

  it("总预算耗尽 → 后续图片 budget（保留引用）", async () => {
    // 总预算 64MB：7 张各 9.5MB（单图 <10MB 过 oversize 门），前 6 张 inlined
    // （57MB），第 7 张 66.5MB > 64MB → budget。同一 buffer 引用挂 7 个路径。
    const big = new Uint8Array(Math.round(INLINE_IMG_MAX_BYTES * 0.95));
    big.set(PNG.subarray(0, 8), 0);
    const srcs = Array.from({ length: 7 }, (_, i) => `p${i}.png`);
    srcs.forEach((s) => adapter.__files.set(`C:/docs/${s}`, big));
    const r = await inlineExportImages(srcs.map((s) => img(s)).join(""), DOC);
    expect(r.report.map((i) => i.status)).toEqual([
      ...Array(6).fill("inlined"),
      "budget",
    ]);
    expect(r.missing).toHaveLength(1);
    expect(r.html).toContain('src="p6.png"');
  });

  it("读盘失败 → read-error（detail 带原因）", async () => {
    const r = await inlineExportImages(img("gone.png"), DOC);
    expect(r.report[0].status).toBe("read-error");
    expect(r.report[0].detail).toBeTruthy();
  });

  it("同一文件多次引用 → 单次读取、两处换装、报告按唯一 src 计一条", async () => {
    adapter.__files.set("C:/docs/same.png", PNG);
    const r = await inlineExportImages(img("same.png") + img("same.png"), DOC);
    expect(fsCalls.filter((c) => c.op === "read")).toHaveLength(1);
    expect(r.report).toHaveLength(1);
    expect(r.report[0].status).toBe("inlined");
    expect(r.html.match(/data:image\/png/g)?.length).toBe(2);
  });

  it("data:/asset:/blob: 引用不进报告（非内联对象，行为保持）", async () => {
    const html = img("data:image/png;base64,xx") + img("asset://localhost/a.png") + img("blob:x");
    const r = await inlineExportImages(html, DOC);
    expect(r.report).toEqual([]);
  });

  it("无 docPath → 相对引用无从解析，显式 read-error（必然裂图须列报）", async () => {
    const r = await inlineExportImages(img("a.png"), null);
    expect(r.report).toHaveLength(1);
    expect(r.report[0].status).toBe("read-error");
    expect(r.missing).toHaveLength(1);
  });
});

describe("formatMissingImages（C2 列报文案）", () => {
  it("空清单 → 空串", () => {
    expect(formatMissingImages([])).toBe("");
  });

  it("逐项列 src + 中文原因，超长 src 截断", () => {
    const items: ExportImageReportItem[] = [
      { src: "assets/big.png", status: "oversize", bytes: 11_000_000 },
      { src: "https://example.com/" + "a".repeat(100) + ".png", status: "remote-timeout" },
    ];
    const text = formatMissingImages(items);
    expect(text).toContain("以下 2 张图片未包含");
    expect(text).toContain("assets/big.png —— 超过 10MB 单图上限");
    expect(text).toContain("remote-timeout".replace("remote-timeout", "下载超时（15 秒）"));
    expect(text).toContain("…"); // 超长 URL 截断标记
    expect(text.split("\n")).toHaveLength(3); // 标题 + 2 项（无「等共」尾行）
  });

  it("超过 8 项 → 截断到 8 行 + 「等共 N 项」", () => {
    const items: ExportImageReportItem[] = Array.from({ length: 10 }, (_, i) => ({
      src: `a${i}.png`,
      status: "read-error" as const,
    }));
    const text = formatMissingImages(items);
    expect(text).toContain("……等共 10 项");
    expect(text).not.toContain("a9.png");
  });
});

describe("inlineExportImages 远程图（D-5：fetch→dataURL，失败显式入清单）", () => {
  it("remote:fetch 成功 → inlined（经魔数嗅探）", async () => {
    adapter.__files.set("https://x.test/a.gif", GIF);
    const r = await inlineExportImages(img("https://x.test/a.gif"), DOC, { remote: "fetch" });
    expect(r.report[0]).toEqual({ src: "https://x.test/a.gif", status: "inlined", bytes: GIF.byteLength });
    expect(r.html).toContain('src="data:image/gif;base64,');
  });

  it("remote:fetch 网络失败 → remote-error", async () => {
    const r = await inlineExportImages(img("https://x.test/gone.png"), DOC, { remote: "fetch" });
    expect(r.report[0].status).toBe("remote-error");
    expect(r.missing).toHaveLength(1);
  });

  it("remote:fetch 超时（fetchImage 挂起不归返）→ remote-timeout", async () => {
    adapter.app.fetchImage = () => new Promise(() => {}); // 永挂
    try {
      const r = await inlineExportImages(img("https://x.test/slow.png"), DOC, {
        remote: "fetch",
        remoteTimeoutMs: 30,
      });
      expect(r.report[0].status).toBe("remote-timeout");
    } finally {
      adapter.app.fetchImage = async (url: string) => {
        const u = adapter.__files.get(url);
        if (!u) throw new Error("download failed");
        return u;
      };
    }
  });

  it("remote:fetch 抓回的未知格式 → sniff-fail（与本地同一道门）", async () => {
    adapter.__files.set("https://x.test/bad.png", GARBAGE);
    const r = await inlineExportImages(img("https://x.test/bad.png"), DOC, { remote: "fetch" });
    expect(r.report[0].status).toBe("sniff-fail");
  });

  it("remote:skip（默认，HTML 保留引用模式的语义）→ remote-skip、不抓取", async () => {
    const r = await inlineExportImages(img("https://x.test/a.png"), DOC);
    expect(r.report[0].status).toBe("remote-skip");
    expect(fsCalls.filter((c) => c.op === "fetch")).toHaveLength(0);
    // remote-skip 是文档化语义而非缺陷：不计入 missing 列报
    expect(r.missing).toEqual([]);
  });

  it("远程图计入总预算（7×9.5MB → 恰好 1 张 budget）", async () => {
    const big = new Uint8Array(Math.round(INLINE_IMG_MAX_BYTES * 0.95));
    big.set(GIF.subarray(0, 6), 0);
    const urls = Array.from({ length: 7 }, (_, i) => `https://x.test/b${i}.gif`);
    urls.forEach((u) => adapter.__files.set(u, big));
    const r = await inlineExportImages(urls.map((u) => img(u)).join(""), DOC, { remote: "fetch" });
    // 并发池（3）下 budget 落在谁身上取决于完成顺序，只断言计数。
    const statuses = r.report.map((i) => i.status);
    expect(statuses.filter((s) => s === "inlined")).toHaveLength(6);
    expect(statuses.filter((s) => s === "budget")).toHaveLength(1);
    expect(r.missing).toHaveLength(1);
  });
});

// ---- C2 产物内显式占位（EX 轮 markMissingImages）----
describe("markMissingImages", () => {
  it("未内联 <img> 换成带原因的占位框；已内联/无缺失不受影响", () => {
    const html =
      '<p><img src="assets/ok.png"><img src="assets/big.png" alt="大图"></p>';
    const out = markMissingImages(html, [
      { src: "assets/big.png", status: "oversize", bytes: 15_000_000 },
    ]);
    expect(out).toContain('src="assets/ok.png"'); // 未提及的图不动
    expect(out).not.toContain('src="assets/big.png"');
    expect(out).toContain("图片未包含");
    expect(out).toContain("超过 10MB 单图上限");
    expect(out).not.toContain('alt="大图"'); // 原 img 整体被换掉
  });

  it("src 含正则元字符也安全（路径点号/括号）；无缺失原样返回", () => {
    const html = '<img src="assets/pic (v1.2).png">';
    const out = markMissingImages(html, [
      { src: "assets/pic (v1.2).png", status: "read-error", detail: "x" },
    ]);
    expect(out).toContain("图片未包含");
    expect(out).not.toContain("<img");
    expect(markMissingImages(html, [])).toBe(html); // 空 missing = 原引用
  });
});
