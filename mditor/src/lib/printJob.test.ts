// @vitest-environment jsdom
// printJob 纯函数面 + 作业编排面（PI2）。jsdom：作业编排走 canvas stub
// （renderPageToPng 的浏览器面不在此测，真机手测覆盖）；platform adapter
// 按 fileOps.test.ts 惯例 mock（顶层可变夹具 + vi.mock 工厂引用）。

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockFs = {
  mkdir: vi.fn(async (_p: string, _o?: { recursive?: boolean }) => undefined),
  readDir: vi.fn(async (_p: string) => [] as Array<{ name: string; isDirectory?: boolean }>),
  stat: vi.fn(async (_p: string) => ({ mtime: new Date() })),
  remove: vi.fn(async (_p: string, _o?: { recursive?: boolean }) => undefined),
  writeFile: vi.fn(async (_p: string, _d: Uint8Array) => undefined),
  readTextFile: vi.fn(async (_p: string) => ""),
  readFile: vi.fn(async (_p: string) => PNG_MAGIC),
};
/** 最小 PNG 魔数 + 尾余（sniffImageMime 只看前 8 字节）。 */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const mockApp = {
  appDataDir: vi.fn(async () => "/appdata"),
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => true),
  listen: vi.fn(async (_ev: string, _h: (e: { payload: unknown }) => void) => () => undefined),
};

vi.mock("../platform", () => ({
  getAdapter: () => ({ app: mockApp, fs: mockFs }),
}));

import {
  cleanupOldPrintFiles,
  inlineCssUrls,
  ensureJobDir,
  extractHtmlPrintParts,
  jobDirName,
  localHrefToAbs,
  parsePageRange,
  printTimestamp,
  runPrintJob,
  sanitizePrintStem,
  PRINT_DPI_CHOICES,
  PRINT_JOB_EVENT,
} from "./printJob";

const T = new Date(2026, 10, 3, 9, 5, 7);

// ---- 页面范围 -----------------------------------------------------------------

describe("parsePageRange", () => {
  it("「1-3,5」→ [1,2,3,5]；去重升序", () => {
    const r = parsePageRange("1-3,5", 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pages).toEqual([1, 2, 3, 5]);
    const dup = parsePageRange("5,1,1-2", 10);
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.pages).toEqual([1, 2, 5]);
  });

  it("容忍中文逗号/分号/空白与 – ~ 连字符", () => {
    const r = parsePageRange("1–2，4；6~7  9", 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pages).toEqual([1, 2, 4, 6, 7, 9]);
  });

  it("空输入 / 非法 token / 逆序区间 / 越界 → ok:false 带原因", () => {
    expect(parsePageRange("", 10)).toEqual({ ok: false, error: "未输入页码" });
    expect(parsePageRange("  ", 10).ok).toBe(false);
    const bad = parsePageRange("1,a", 10);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("a");
    expect(parsePageRange("5-3", 10).ok).toBe(false);
    const over = parsePageRange("1-11", 10);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("共 10 页");
    expect(parsePageRange("1", 0).ok).toBe(false);
  });
});

// ---- html 内容源提取 ------------------------------------------------------------

describe("extractHtmlPrintParts", () => {
  it("完整文档：body 内文（style 剥除）+ head 内联 style 收集 + 本地 link 收集 + 远程 link 计数", () => {
    const doc = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="base.css">
      <link rel="stylesheet" href="https://cdn.example.com/x.css">
      <link rel="icon" href="favicon.ico">
      <style>body{color:red}</style>
      </head><body class="page"><h1>标题</h1><style>h1{margin:0}</style><p>正文</p></body></html>`;
    const parts = extractHtmlPrintParts(doc);
    expect(parts.bodyHtml).toContain("<h1>标题</h1>");
    expect(parts.bodyHtml).toContain("<p>正文</p>");
    expect(parts.bodyHtml).not.toContain("style");
    expect(parts.inlineCss).toContain("body{color:red}");
    expect(parts.inlineCss).toContain("h1{margin:0}");
    expect(parts.localCssHrefs).toEqual(["base.css"]);
    expect(parts.remoteStyles).toBe(1); // icon link 不计
  });

  it("大写标签与单引号属性", () => {
    const doc = `<HTML><HEAD><STYLE>.a{}</STYLE><LINK REL='stylesheet' HREF='s.css'></HEAD><BODY><B>x</B></BODY></HTML>`;
    const parts = extractHtmlPrintParts(doc);
    expect(parts.inlineCss).toContain(".a{}");
    expect(parts.localCssHrefs).toEqual(["s.css"]);
    expect(parts.bodyHtml).toBe("<B>x</B>");
  });

  it("残缺文档（无 body/style/link）：全文当正文，不报错", () => {
    const parts = extractHtmlPrintParts("<div>碎片</div>");
    expect(parts.bodyHtml).toBe("<div>碎片</div>");
    expect(parts.inlineCss).toBe("");
    expect(parts.localCssHrefs).toEqual([]);
    expect(parts.remoteStyles).toBe(0);
  });
});

describe("inlineCssUrls / localHrefToAbs", () => {
  it("css 相对 url() → fs 读取后 data: 内联（魔数定 MIME；CSP 无 file: 不再丢图）", async () => {
    const css = 'body{background:url(img/a.png)} .b{background:url("b c.png")}';
    const r = await inlineCssUrls(css, "C:/docs/notes/page.html");
    expect(r.failed).toBe(0);
    expect(r.css).toContain('url("data:image/png;base64,');
    // 两个引用都成功内联（同名引用读取一次、替换两处）。
    expect(mockFs.readFile).toHaveBeenCalled();
  });

  it("data:/http(s) url 原样跳过；无 cssPath 原样返回", async () => {
    const css = 'a{background:url(data:image/png;base64,xx)} b{background:url(https://e.com/x.png)}';
    const r = await inlineCssUrls(css, "C:/d.html");
    expect(r.css).toContain("data:image/png;base64,xx");
    expect(r.css).toContain("https://e.com/x.png");
    expect(await inlineCssUrls(css, null)).toEqual({ css, failed: 0 });
  });

  it("读取失败 → 保留原引用并计数 failed（铁律 5 列报源）", async () => {
    mockFs.readFile.mockRejectedValueOnce(new Error("locked"));
    const r = await inlineCssUrls('a{background:url(miss.png)}', "C:/d.html");
    expect(r.css).toContain("miss.png");
    expect(r.failed).toBe(1);
  });

  it("localHrefToAbs：相对拼接 / 绝对保留 / 远程 null", () => {
    expect(localHrefToAbs("a.css", "C:/docs/notes")).toContain("C:");
    expect(localHrefToAbs("a.css", "C:/docs/notes")).toContain("a.css");
    expect(localHrefToAbs("/abs/root.css", "C:/x")).toMatch(/root\.css$/);
    expect(localHrefToAbs("https://e.com/a.css", "C:/x")).toBeNull();
  });

});

// ---- 临时件命名与清理 -----------------------------------------------------------

describe("临时件命名", () => {
  it("sanitizePrintStem：非法字符→_、剥尾部点空格、截断 60、空兜底", () => {
    expect(sanitizePrintStem("a<b>c:d?e*f|")).toBe("a_b_c_d_e_f_");
    expect(sanitizePrintStem("name.. ")).toBe("name");
    expect(sanitizePrintStem("x".repeat(80))).toHaveLength(60);
    expect(sanitizePrintStem("???")).not.toBe("");
    expect(sanitizePrintStem("  ")).toBe("note");
  });

  it("printTimestamp / jobDirName：固定时间锚定", () => {
    expect(printTimestamp(T)).toBe("20261103-090507");
    expect(jobDirName("我的 笔记", T)).toBe("job-我的 笔记-20261103-090507");
    expect(jobDirName("a/b", T)).toBe("job-a_b-20261103-090507");
  });

  it("ensureJobDir：mkdir 递归建 print/ 与 job-*/", async () => {
    mockFs.mkdir.mockClear();
    const dir = await ensureJobDir("doc");
    expect(dir).toContain("print");
    expect(dir).toContain("job-doc-");
    expect(mockFs.mkdir).toHaveBeenCalledTimes(2);
  });
});

describe("cleanupOldPrintFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("48h 前旧件删除（recursive），新件保留；单文件失败不阻断", async () => {
    const now = Date.now();
    mockFs.readDir.mockResolvedValue([
      { name: "old.html" },
      { name: "job-old" },
      { name: "fresh.html" },
    ]);
    mockFs.stat.mockImplementation(async (p: string) => ({
      mtime: new Date(String(p).includes("old") ? now - 49 * 3600_000 : now - 1000),
    }));
    await cleanupOldPrintFiles();
    const removed = mockFs.remove.mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.includes("old.html"))).toBe(true);
    expect(removed.some((p) => p.includes("job-old"))).toBe(true);
    expect(removed.some((p) => p.includes("fresh"))).toBe(false);
  });

  it("目录不存在：console.warn 不抛", async () => {
    mockFs.readDir.mockRejectedValue(new Error("no dir"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(cleanupOldPrintFiles()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---- 打印作业编排（jsdom canvas stub + mock invoke/listen）----------------------

describe("runPrintJob 编排", () => {
  /** jsdom 无 2d canvas：stub 原型（渲染位图内容不在此测）。 */
  beforeAll(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      }
    );
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext =
      () => ({ fillRect: () => undefined });
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toBlob = (
      cb: (b: Blob | null) => void
    ) => cb(new Blob(["png"], { type: "image/png" }));
  });

  function fakeDoc(): {
    doc: { getPage: () => Promise<unknown> };
    events: Array<(e: { payload: unknown }) => void>;
  } {
    const events: Array<(e: { payload: unknown }) => void> = [];
    mockApp.listen.mockImplementation(
      async (_ev: string, h: (e: { payload: unknown }) => void) => {
        events.push(h);
        return () => undefined;
      }
    );
    return {
      events,
      doc: {
        getPage: async () => ({
          view: [0, 0, 595, 842],
          getViewport: ({ scale }: { scale: number }) => ({
            width: 595 * scale,
            height: 842 * scale,
          }),
          render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
          // n 仅作页号占位（fake doc 不校验范围）
        }),
      },
    };
  }

  function fireDone(events: Array<(e: { payload: unknown }) => void>, job: string): void {
    for (const h of events) h({ payload: { job, kind: "done", page: 2, total: 2, message: "" } });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.appDataDir.mockResolvedValue("/appdata");
  });

  it("完整链：逐页渲染写 PNG → invoke print_png_job（页路径+份数+纸张）→ done → job 目录清理", async () => {
    const { doc, events } = fakeDoc();
    const done = runPrintJob({
      jobId: "j1",
      doc: doc as never,
      pages: [1, 2],
      printer: "Microsoft Print to PDF",
      copies: 2,
      dpi: 150,
      paper: "A4",
      stem: "笔记",
    });
    // invoke 启动后触发 done 事件（等 invoke 被调用）。
    await vi.waitFor(() => expect(mockApp.invoke).toHaveBeenCalled());
    const [cmd, args] = mockApp.invoke.mock.calls.find(
      (c) => String(c[0]) === "print_png_job"
    ) as [string, Record<string, unknown>];
    expect(cmd).toBe("print_png_job");
    expect((args.pages as string[]).length).toBe(2);
    expect((args.pages as string[])[0]).toContain("page-001.png");
    expect(args.copies).toBe(2);
    expect(args.paper).toBe("A4");
    expect(args.printer).toBe("Microsoft Print to PDF");
    fireDone(events, "j1");
    const out = await done;
    expect(out).toEqual({ outcome: "done", total: 2 });
    await vi.waitFor(() =>
      expect(mockFs.remove).toHaveBeenCalledWith(expect.stringContaining("job-j1-笔记"), {
        recursive: true,
      })
    );
  });

  it("failed 事件 → 抛错且 job 目录仍被清理（铁律 2/5）", async () => {
    const { doc, events } = fakeDoc();
    const p = runPrintJob({
      jobId: "j2",
      doc: doc as never,
      pages: [1],
      printer: "p",
      copies: 1,
      dpi: 150,
      paper: null,
      stem: "x",
    });
    await vi.waitFor(() => expect(mockApp.invoke).toHaveBeenCalled());
    for (const h of events)
      h({ payload: { job: "j2", kind: "failed", page: 0, total: 1, message: "驱动失败" } });
    await expect(p).rejects.toThrow("驱动失败");
    expect(mockFs.remove).toHaveBeenCalled();
  });

  it("渲染阶段 abort → AbortError，不 invoke 打印命令", async () => {
    const ctrl = new AbortController();
    const { doc } = fakeDoc();
    const p = runPrintJob({
      jobId: "j3",
      doc: doc as never,
      pages: [1],
      printer: "p",
      copies: 1,
      dpi: 150,
      paper: null,
      stem: "x",
      signal: ctrl.signal,
    });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(mockApp.invoke.mock.calls.some((c) => String(c[0]) === "print_png_job")).toBe(false);
  });
});

// ---- 值域锚点 -------------------------------------------------------------------

describe("打印值域", () => {
  it("PRINT_DPI_CHOICES：标准 150 / 高 300；事件名与 Rust 一致", () => {
    expect(PRINT_DPI_CHOICES.map((c) => c.dpi)).toEqual([150, 300]);
    expect(PRINT_JOB_EVENT).toBe("print-job-progress");
  });
});
