// vaultIndex 单测：行扫描纯函数、打分、以及注入 mock IO 的管理器
// （分批扫描 / 增量更新 / 反链与标签查询 / watch 事件防抖）。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  VaultIndexManager,
  type VaultIndexIO,
  parseVaultDoc,
  rankEntry,
  titleFromPath,
} from "./vaultIndex";

// ---- parseVaultDoc -----------------------------------------------------------

describe("parseVaultDoc（行扫描）", () => {
  it("抽取标题层级与行号，首个 H1 作为 title", () => {
    const doc = parseVaultDoc("# 主标题\n\n正文\n\n## 二级\n\n### 三级");
    expect(doc.title).toBe("主标题");
    expect(doc.headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(doc.headings[1]).toEqual({ level: 2, text: "二级", line: 4 });
  });

  it("无 H1 时 title 为 null（条目层回退文件名）", () => {
    const doc = parseVaultDoc("## 只有二级\n正文");
    expect(doc.title).toBeNull();
    expect(doc.headings.length).toBe(1);
  });

  it("代码围栏内的标题/双链/标签不扫描", () => {
    const doc = parseVaultDoc(
      "# T\n\n```md\n# 假标题\n[[inner]] #faketag\n```\n\n~+\n不是围栏\n"
    );
    expect(doc.headings.length).toBe(1);
    expect(doc.links.length).toBe(0);
    expect(doc.tags).toEqual([]);
  });

  it("双链：target|label 与 target#子标题 拆解，![[嵌入]] 跳过", () => {
    const doc = parseVaultDoc(
      "见 [[目标笔记]]、[[目标|显示名]]、[[目标#章节]]。\n嵌入 ![[图片笔记]]。"
    );
    expect(doc.links.map((l) => l.target)).toEqual(["目标笔记", "目标", "目标"]);
    expect(doc.links.every((l) => l.text.length > 0)).toBe(true);
  });

  it("双链上下文：前后各 1 行", () => {
    const doc = parseVaultDoc("前一行\n见 [[目标]]。\n后一行");
    const l = doc.links[0];
    expect(l.before).toBe("前一行");
    expect(l.after).toBe("后一行");
    expect(l.line).toBe(1);
  });

  it("标签：非行首识别，行首 # 不算（标题语法），纯数字排除", () => {
    const doc = parseVaultDoc(
      "#tag行首不算\n正文 #算法/排序 与 #机器学习。\n问题 #1 不算\n> 引用里 #标签算"
    );
    expect(doc.tags.sort()).toEqual(["机器学习", "标签算", "算法/排序"]);
  });

  it("标签去重", () => {
    const doc = parseVaultDoc("a #dup b\nc #dup d");
    expect(doc.tags).toEqual(["dup"]);
  });
});

describe("titleFromPath", () => {
  it("去扩展名，跨分隔符", () => {
    expect(titleFromPath("C:/notes/我的笔记.md")).toBe("我的笔记");
    expect(titleFromPath("C:\\notes\\a.markdown")).toBe("a");
    expect(titleFromPath("README")).toBe("README");
  });
});

// ---- rankEntry ---------------------------------------------------------------

describe("rankEntry（QuickSwitcher 打分）", () => {
  const entry = { path: "C:/notes/线性代数/矩阵分解.md", title: "矩阵的分解方法" };

  it("前缀 > 词首 > 子串 > 子序列", () => {
    const prefix = rankEntry("矩阵", { path: "C:/n/矩阵分解.md", title: "x" });
    const wordStart = rankEntry("矩阵", { path: "C:/n/my-矩阵.md", title: "x" });
    const substr = rankEntry("矩阵", { path: "C:/n/x矩阵x.md", title: "x" });
    const subseq = rankEntry("矩分", { path: "C:/n/矩阵分解.md", title: "x" });
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substr);
    expect(substr).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it("不匹配返回 0", () => {
    expect(rankEntry("zzz", entry)).toBe(0);
  });

  it("标题命中得分低于文件名命中", () => {
    const byName = rankEntry("矩阵", { path: "C:/n/矩阵.md", title: "其它" });
    const byTitle = rankEntry("分解", { path: "C:/n/矩阵.md", title: "分解入门" });
    expect(byName).toBeGreaterThan(byTitle);
  });

  it("最近打开加权：7 天内 +20，30 天内 +10，更早 +4", () => {
    const now = Date.now();
    const mk = (ageDays: number) =>
      new Map([["c:/notes/a.md", now - ageDays * 86_400_000]]);
    const fresh = rankEntry("a", { path: "C:/notes/a.md", title: "" }, { openedAt: mk(1), now });
    const month = rankEntry("a", { path: "C:/notes/a.md", title: "" }, { openedAt: mk(20), now });
    const old = rankEntry("a", { path: "C:/notes/a.md", title: "" }, { openedAt: mk(90), now });
    const none = rankEntry("a", { path: "C:/notes/a.md", title: "" }, { openedAt: new Map(), now });
    expect(fresh - none).toBe(20);
    expect(month - none).toBe(10);
    expect(old - none).toBe(4);
  });

  it("性能：1000 条目全量打分 <50ms（子串查询）", () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      path: `C:/vault/sub${i % 20}/笔记${i}.md`,
      title: `标题${i}与笔记内容`,
    }));
    const t0 = performance.now();
    let hits = 0;
    for (const e of entries) if (rankEntry("笔记1", e) > 0) hits++;
    const ms = performance.now() - t0;
    expect(hits).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });
});

// ---- VaultIndexManager（mock IO） ---------------------------------------------

function makeIO(files: Map<string, string>, dirs?: Map<string, string[]>): {
  io: VaultIndexIO;
  watchCb: ReturnType<typeof vi.fn>;
} {
  // 从文件表推导目录结构。
  const dirMap = new Map<string, string[]>();
  const all = [...files.keys()];
  for (const f of all) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const list = dirMap.get(dir) ?? [];
      const name = parts[i];
      if (!list.includes(name)) list.push(name);
      dirMap.set(dir, list);
    }
  }
  for (const [d, names] of dirs ?? new Map()) dirMap.set(d, names);
  const watchCb = vi.fn();
  const io: VaultIndexIO = {
    readTextFile: async (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error("ENOENT: " + p);
      return c;
    },
    readDir: async (d) => {
      const names = dirMap.get(d) ?? [];
      return names.map((n) => ({
        name: n,
        isDirectory: (dirMap.get(d + "/" + n) ?? []).length > 0 || !n.includes("."),
      }));
    },
    stat: async () => ({ mtime: 1_700_000_000_000 }),
    watch: async () => {
      // 返回 unwatch；回调经由返回对象之外的 watchCb 触发（测试直接调用）。
      return () => undefined;
    },
  };
  return { io, watchCb };
}

describe("VaultIndexManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("全量扫描建索引（分批 + idle 调度下完成）", async () => {
    const files = new Map<string, string>([
      ["C:/v/a.md", "# 甲\n见 [[乙]]。#tagA"],
      ["C:/v/b.md", "## 乙\n#tagB #tagA"],
      ["C:/v/sub/c.md", "# 丙\n[[乙|显示]]"],
    ]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"]);
    expect(idx.entries().length).toBe(3);
    expect(idx.entry("C:/v/a.md")?.title).toBe("甲");
    expect(idx.entry("C:/v/sub/c.md")?.links[0]?.target).toBe("乙");
  });

  it("无 H1 文档的 title 回退文件名（去扩展名）", async () => {
    const files = new Map<string, string>([["C:/v/b.md", "## 只有二级标题"]]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"]);
    expect(idx.entry("C:/v/b.md")?.title).toBe("b");
  });

  it("保存事件增量更新（noteSaved 直接用内存内容）", async () => {
    const files = new Map<string, string>([["C:/v/a.md", "# 旧标题"]]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"]);
    let version = idx.stats().version;
    idx.noteSaved("C:/v/a.md", "# 新标题\n[[b]]");
    expect(idx.entry("C:/v/a.md")?.title).toBe("新标题");
    expect(idx.entry("C:/v/a.md")?.links.length).toBe(1);
    expect(idx.stats().version).toBeGreaterThan(version);
    version = idx.stats().version;
    // 未保存路径的查询不该有副作用。
    idx.noteSaved("", "x");
    expect(idx.stats().version).toBe(version);
  });

  it("外部修改监听 → 防抖后单文件重扫；读取失败（删除）→ 条目移除", async () => {
    const files = new Map<string, string>([["C:/v/a.md", "# 甲"]]);
    const { io } = makeIO(files);
    let watchHandler: ((ev: { type: { kind?: string }; paths: string[] }) => void) | null =
      null;
    io.watch = async (_d, cb) => {
      watchHandler = cb;
      return () => undefined;
    };
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"]);
    expect(watchHandler).not.toBeNull();

    // 外部修改。
    files.set("C:/v/a.md", "# 甲改\n[[b]]");
    watchHandler!({ type: { kind: "modify" }, paths: ["C:\\v\\a.md"] });
    await vi.advanceTimersByTimeAsync(700);
    expect(idx.entry("C:/v/a.md")?.links.length).toBe(1);

    // 外部删除。
    files.delete("C:/v/a.md");
    watchHandler!({ type: { kind: "remove" }, paths: ["C:\\v\\a.md"] });
    await vi.advanceTimersByTimeAsync(700);
    expect(idx.entry("C:/v/a.md")).toBeNull();
  });

  it("反链查询：按文件名匹配来源 + 上下文片段", async () => {
    const files = new Map<string, string>([
      ["C:/v/甲.md", "# 甲\n\n见 [[乙]] 说明。"],
      ["C:/v/sub/丙.md", "# 丙\n前文\n[[乙|别名]] 后文\n再后一行"],
      ["C:/v/乙.md", "# 乙"],
    ]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"]);
    const bl = idx.backlinksTo("C:/v/乙.md");
    expect(bl.length).toBe(2);
    expect(bl.map((x) => x.source).sort()).toEqual(["C:/v/sub/丙.md", "C:/v/甲.md"]);
    const fromC = bl.find((x) => x.source === "C:/v/sub/丙.md")!;
    expect(fromC.link.before).toBe("前文");
    expect(fromC.link.after).toBe("再后一行");
  });

  it("标签计数与过滤", async () => {
    const files = new Map<string, string>([
      ["C:/v/a.md", "a #数学 #代数"],
      ["C:/v/b.md", "b #数学"],
    ]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"]);
    expect(idx.allTags()).toEqual([
      { tag: "数学", count: 2 },
      { tag: "代数", count: 1 },
    ]);
    expect(idx.notesWithTag("数学").length).toBe(2);
    expect(idx.notesWithTag("不存在").length).toBe(0);
  });

  it("双链目标解析：重名返回多条（消歧用）", async () => {
    const files = new Map<string, string>([
      ["C:/v/x/a.md", "# A"],
      ["C:/v/y/a.md", "# 另一个 A"],
    ]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"]);
    expect(idx.resolveWikiTarget("a").length).toBe(2);
    expect(idx.resolveWikiTarget("A").length).toBe(2); // 大小写不敏感
    expect(idx.resolveWikiTarget("missing").length).toBe(0);
  });

  it("排除目录（excluded）不进索引", async () => {
    const files = new Map<string, string>([
      ["C:/v/a.md", "# A"],
      ["C:/v/secret/s.md", "# S"],
    ]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    await idx.setRootsAndWait(["C:/v"], new Set(["C:/v/secret"]));
    expect(idx.entries().length).toBe(1);
    expect(idx.entry("C:/v/secret/s.md")).toBeNull();
  });

  it("订阅：索引变更通知订阅方", async () => {
    const files = new Map<string, string>([["C:/v/a.md", "# A"]]);
    const { io } = makeIO(files);
    const idx = new VaultIndexManager(io);
    const fn = vi.fn();
    idx.subscribe(fn);
    await idx.setRootsAndWait(["C:/v"]);
    expect(fn.mock.calls.length).toBeGreaterThan(0);
  });
});
