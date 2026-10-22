// HN 轮阶段 1：htmlNote 纯函数单测（扩展名 / TabItem / asset URL 相对解析 /
// 冲突改名 / 导入拷贝）。平台适配层 mock（对齐 fileOps.test.ts 惯例）。

import { describe, expect, it, vi, beforeEach } from "vitest";

// convertFileSrc 按 @tauri-apps/api 的真实形态 mock：整体 encodeURIComponent
// （分隔符也编成 %2F）——assetFrameUrl 的回归靶子正是这个形态。
// mockFs 在各导入用例内切换（getAdapter 调用时才求值，无 hoist TDZ 问题）。
vi.mock("../platform", () => ({
  detectRuntime: () => "tauri",
  getAdapter: () => ({
    runtime: "tauri",
    app: {
      convertFileSrc: (p: string) =>
        `http://asset.localhost/${encodeURIComponent(p)}`,
    },
    fs: mockFs,
    capabilities: { htmlNoteView: true },
  }),
}));

import {
  HTML_EXTS,
  HTML_NOTE_SANDBOX,
  assetFrameUrl,
  conflictFreeName,
  importHtmlNotes,
  isHtmlNote,
  isHtmlTab,
  htmlTabKey,
  makeHtmlTab,
} from "./htmlNote";

// ---- fs mock（importHtmlNotes 用）-------------------------------------------

/** 当前注入的 fs mock（import 用例在测试体内切换）。 */
let mockFs: {
  readDir: (d: string) => Promise<Array<{ name: string; isDirectory: boolean }>>;
  readFile: (p: string) => Promise<Uint8Array>;
  writeFile: (p: string, data: Uint8Array) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
  stat: (
    p: string
  ) => Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: Date | null } | null>;
};

function mkFs(tree: Record<string, string | null>) {
  // tree: 路径（文件，值为内容标识）或目录（值为 null）。
  const written = new Map<string, Uint8Array>();
  const made = new Set<string>();
  const entries = (dir: string) =>
    Object.keys(tree)
      .filter((p) => p.startsWith(dir + "/"))
      .map((p) => p.slice(dir.length + 1).split("/")[0])
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((name) => {
        const full = `${dir}/${name}`;
        return { name, isDirectory: tree[full] === null };
      });
  return {
    written,
    made,
    adapter: {
      readDir: async (d: string) => entries(d),
      readFile: async (p: string) => {
        if (!(p in tree) || tree[p] === null) throw new Error("ENOENT " + p);
        return new TextEncoder().encode(`bytes-of:${p}`);
      },
      writeFile: async (p: string, data: Uint8Array) => {
        written.set(p, data);
      },
      mkdir: async (p: string) => {
        made.add(p);
      },
      stat: async (p: string) => {
        if (!(p in tree)) return null;
        return { isFile: tree[p] !== null, isDirectory: tree[p] === null, size: 1, mtime: null };
      },
    },
    set(path: string, isDir = false) {
      tree[path] = isDir ? null : "content";
    },
  };
}

// ---- 扩展名 / TabItem --------------------------------------------------------

describe("HTML_EXTS / isHtmlNote", () => {
  it("识别 .html/.htm（大小写不敏感），排除 md 与无扩展名", () => {
    expect(isHtmlNote("a.html")).toBe(true);
    expect(isHtmlNote("b.HTM")).toBe(true);
    expect(isHtmlNote("c.htm")).toBe(true);
    expect(isHtmlNote("d.md")).toBe(false);
    expect(isHtmlNote("noext")).toBe(false);
    expect(isHtmlNote("e.htmlx")).toBe(false);
    expect(HTML_EXTS.has(".html")).toBe(true);
  });
});

describe("TabItem kind 判别", () => {
  it("makeHtmlTab：kind=html、dirty 恒 false、content 恒空、key 路径归一", () => {
    const t = makeHtmlTab("C:\\Notes\\Demo.HTML");
    expect(t.kind).toBe("html");
    expect(t.dirty).toBe(false);
    expect(t.content).toBe("");
    expect(t.name).toBe("Demo.HTML");
    expect(t.key).toBe(htmlTabKey("C:\\Notes\\Demo.HTML"));
    expect(t.key).toBe("html-c:/notes/demo.html"); // Windows 大小写不敏感
  });

  it("isHtmlTab：undefined kind = md（兼容既有构造点）", () => {
    expect(isHtmlTab({ key: "untitled-1", path: null, name: "未命名.md", dirty: false, content: "" })).toBe(false);
    expect(isHtmlTab(makeHtmlTab("C:/x.html"))).toBe(true);
    expect(isHtmlTab(null)).toBe(false);
  });

  it("sandbox 形态：无 allow-same-origin（隔离铁律）", () => {
    expect(HTML_NOTE_SANDBOX).toContain("allow-scripts");
    expect(HTML_NOTE_SANDBOX).not.toContain("allow-same-origin");
  });
});

// ---- assetFrameUrl（spike ② 根因的回归钉）------------------------------------

describe("assetFrameUrl", () => {
  it("保留字面斜杠（convertFileSrc 的 %2F 形态必须被改写）", () => {
    const u = assetFrameUrl("C:/Users/hh/我的 文件/index.html");
    expect(u.startsWith("http://asset.localhost/")).toBe(true);
    expect(u).toBe("http://asset.localhost/C%3A/Users/hh/%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6/index.html");
    // 不允许出现编码后的分隔符。
    expect(u).not.toMatch(/%2F/i);
  });

  it("相对引用按目录层级解析（spike 失败形态的直接反证）", () => {
    const doc = assetFrameUrl("C:/vault/notes/demo/index.html");
    const img = new URL("assets/x.png", doc);
    expect(decodeURIComponent(img.pathname)).toBe("/C:/vault/notes/demo/assets/x.png");
    const up = new URL("../assets/x.png", doc);
    expect(decodeURIComponent(up.pathname)).toBe("/C:/vault/notes/assets/x.png");
  });

  it("反斜杠路径同样工作（Windows 形态）", () => {
    const u = assetFrameUrl("C:\\vault\\a b\\note.html");
    expect(u).toBe("http://asset.localhost/C%3A/vault/a%20b/note.html");
  });
});

// ---- 冲突改名 / 导入 -----------------------------------------------------------

describe("conflictFreeName", () => {
  it("无冲突原样返回；冲突递增后缀；消耗的名字不会复用", () => {
    expect(conflictFreeName("n.html", new Set())).toBe("n.html");
    const taken = new Set(["n.html", "n (1).html"]);
    expect(conflictFreeName("n.html", taken)).toBe("n (2).html");
  });

  it("无扩展名与多段扩展名", () => {
    expect(conflictFreeName("folder", new Set(["folder"]))).toBe("folder (1)");
    expect(conflictFreeName("a.tar.gz", new Set(["a.tar.gz"]))).toBe("a.tar (1).gz");
  });
});

describe("importHtmlNotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("单文件导入：拷入 vault 根；伴随 _files 目录随之；无冲突", async () => {
    const fs = mkFs({
      "V": null,
      "S/page.html": "html",
      "S/page_files": null,
      "S/page_files/img.png": "png",
    });
    mockFs = fs.adapter;
    const r = await importHtmlNotes(["S/page.html"], "V");
    expect(r.htmlFiles).toEqual(["V/page.html"]);
    expect([...fs.written.keys()].sort()).toEqual([
      "V/page.html",
      "V/page_files/img.png",
    ]);
    expect(r.renamed).toEqual([]);
  });

  it("同名冲突自动改名，绝不覆盖", async () => {
    const fs = mkFs({ "V": null, "V/page.html": "existing", "S/page.html": "new" });
    mockFs = fs.adapter;
    const r = await importHtmlNotes(["S/page.html"], "V");
    expect(r.htmlFiles).toEqual(["V/page (1).html"]);
    expect(r.renamed).toEqual(["page.html → page (1).html"]);
    expect(fs.written.has("V/page.html")).toBe(false); // 原文件未被动
  });

  it("文件夹导入：整目录按原名入 vault，html 清单含子目录文件", async () => {
    const fs = mkFs({
      "V": null,
      "S/bundle": null,
      "S/bundle/index.html": "html",
      "S/bundle/assets": null,
      "S/bundle/assets/x.png": "png",
      "S/bundle/.hidden": "skip",
    });
    mockFs = fs.adapter;
    const r = await importHtmlNotes(["S/bundle"], "V");
    expect(r.htmlFiles).toEqual(["V/bundle/index.html"]);
    expect([...fs.written.keys()].sort()).toEqual([
      "V/bundle/assets/x.png",
      "V/bundle/index.html",
    ]);
    expect(fs.written.has("V/bundle/.hidden")).toBe(false); // 隐藏文件跳过
  });

  it("非 html 源被忽略", async () => {
    const fs = mkFs({ "V": null, "S/a.txt": "t" });
    mockFs = fs.adapter;
    const r = await importHtmlNotes(["S/a.txt"], "V");
    expect(r.copied).toEqual([]);
    expect(r.htmlFiles).toEqual([]);
  });
});
