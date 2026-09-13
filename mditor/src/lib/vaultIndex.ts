// 全库轻量索引（模块 1「知识功能」地基）。
//
// 目标：对 workspace 全部 .md 维护一个内存索引（标题/大纲/双链/标签），
// 供快速切换器（Ctrl+P）、反链面板、标签过滤、闪卡到期扫描与 RAG 分块
// 复用。全部数据只在本进程内存中，不落盘、不上传（本地优先红线）。
//
// 解析用**轻量行扫描**（正则抽标题 / [[链接]] / #tag），不走完整 remark——
// 全库 remark 解析成本不可接受（docs/performance.md 的既定纪律）。代码
// 围栏（``` / ~~~）内的内容不参与扫描，避免示例代码污染索引。
//
// 扫描调度（铁律 4）：
//   * 分批（每批 ≤50 文件），批间 idle 让出主线程；
//   * shouldYield()（大文档性能模式 + 用户正在输入/滚动）时持续让路；
//   * 保存事件（noteSaved）与文件监听（watch）走**单文件增量重扫**，
//     绝不触发全量重建。

import { getAdapter } from "../platform";
import { UnsupportedError } from "../platform/errors";
import { basename, extname, join, toPosix } from "./path-shim";
import { isUserActive } from "./activity";
import { scanFlashcards, type ScannedCard } from "./flashcards";

// ---- 纯函数部分（独立导出以便单测） ------------------------------------------

export interface VaultHeading {
  level: number; // 1..6
  text: string;
  /** 0-based 行号。 */
  line: number;
}

/** 一条出链：[[target|label]] 的记录（label 不存——上下文行已含原文）。 */
export interface VaultLink {
  /** 链接目标（`|` 显示名与 `#` 子标题之前的部分，原样保留大小写）。 */
  target: string;
  line: number;
  /** 链接所在整行（裁剪到 ~160 字符）。 */
  text: string;
  /** 前 / 后各 1 行（反链面板的上下文片段）。 */
  before: string;
  after: string;
}

export interface VaultEntry {
  path: string;
  title: string;
  headings: VaultHeading[];
  links: VaultLink[];
  tags: string[];
  mtime: number;
  /** 文内 :::flash 闪卡（模块 4：到期扫描遍历索引，不回读文件）。 */
  flashcards: ScannedCard[];
}

/** 行扫描产物。 */
export interface ParsedVaultDoc {
  /** 首个 H1 文本；无 H1 时为 null（条目回退文件名）。 */
  title: string | null;
  headings: VaultHeading[];
  links: VaultLink[];
  tags: string[];
  flashcards: ScannedCard[];
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)\s*$/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g;
// 行内 #tag：前面必须是非行首的空白/开括号类字符（行首 # 是标题语法，
// 参照 Obsidian 规则不识别为标签）。tag 字符集：字母/数字/CJK/下划线/
// 连字符/斜杠（层级标签 a/b）。
const TAG_RE = /[\s（(【[>「]#([\p{L}\p{N}_/-]+)/gu;

/** 单文档轻量解析（纯函数）。 */
export function parseVaultDoc(content: string): ParsedVaultDoc {
  const headings: VaultHeading[] = [];
  const links: VaultLink[] = [];
  const tags: string[] = [];
  let title: string | null = null;
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceMark = "";
  // 模块 4：闪卡扫描（独立行扫描器，与主扫描同样跳过代码围栏）。
  const flashcards = scanFlashcards(content, "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);
    if (fence) {
      const mark = fence[1][0].repeat(3);
      if (!inFence) {
        inFence = true;
        fenceMark = mark;
      } else if (line.trim().startsWith(fenceMark)) {
        inFence = false;
        fenceMark = "";
      }
      continue;
    }
    if (inFence) continue;

    const h = line.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      headings.push({ level, text, line: i });
      if (level === 1 && title === null) title = text;
      // 标题行内的标签/双链不扫（标题文本已入大纲）。
      continue;
    }

    // 双链（图片嵌入 ![[x]] 跳过）。
    for (const m of line.matchAll(WIKILINK_RE)) {
      if (m.index > 0 && line[m.index - 1] === "!") continue;
      const raw = m[1].trim();
      if (!raw) continue;
      const target = raw.split("|")[0].split("#")[0].trim();
      if (!target) continue;
      links.push({
        target,
        line: i,
        text: clipLine(line),
        before: clipLine(lines[i - 1] ?? ""),
        after: clipLine(lines[i + 1] ?? ""),
      });
    }

    // 行内标签。
    for (const tm of line.matchAll(TAG_RE)) {
      const tag = tm[1];
      // 排除纯数字标签（如 “#1”）与 Markdown 自身语法残留。
      if (/^\d+$/.test(tag)) continue;
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  return { title, headings, links, tags, flashcards };
}

function clipLine(s: string): string {
  const t = s.trimEnd();
  return t.length <= 160 ? t : t.slice(0, 159) + "…";
}

/** 文件名（去扩展名）作为标题兜底。 */
export function titleFromPath(path: string): string {
  const b = basename(path);
  const ext = extname(b);
  return ext ? b.slice(0, b.length - ext.length) : b;
}

/** 路径匹配键：分隔符归一 + 小写（Windows 大小写不敏感）。 */
function pathKey(p: string): string {
  return toPosix(p).toLowerCase();
}

/** 去扩展名的 basename（小写、分隔符归一），双链目标解析用。 */
function stemOf(path: string): string {
  const key = pathKey(path);
  const i = key.lastIndexOf("/");
  const b = i < 0 ? key : key.slice(i + 1);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
}

// ---- QuickSwitcher 打分（纯函数） --------------------------------------------

export interface RankContext {
  /** path(pathKey) → 最近打开时间（epoch ms）。 */
  openedAt: Map<string, number>;
  /** 排序时刻。 */
  now?: number;
}

/**
 * 模糊打分：0 = 不匹配。前缀 > 词首 > 子串 > 子序列；命中字段在文件名上
 * 得分高于标题高于路径。最近打开（7 天内 +20，30 天内 +10）叠加为最终排序键。
 * 设计约束：1000+ 条目全量打分须 <10ms（单次线性扫，无回溯）。
 */
export function rankEntry(
  query: string,
  entry: { path: string; title: string },
  ctx?: RankContext
): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    // 空查询：仅按 recency 排（无 recency 数据时保持稳定序）。
    return recencyBonus(entry.path, ctx) + 1;
  }
  const stem = stemOf(entry.path);
  const name = basename(entry.path).toLowerCase();
  const title = entry.title.toLowerCase();
  const dir = toPosix(entry.path).toLowerCase().slice(0, Math.max(0, entry.path.length - name.length));
  let score = 0;
  score = Math.max(score, matchScore(q, stem, 100));
  score = Math.max(score, matchScore(q, name, 92));
  score = Math.max(score, matchScore(q, title, 84));
  score = Math.max(score, matchScore(q, dir, 40));
  if (score === 0) return 0;
  return score + recencyBonus(entry.path, ctx);
}

function recencyBonus(path: string, ctx?: RankContext): number {
  if (!ctx || ctx.openedAt.size === 0) return 0;
  const t = ctx.openedAt.get(pathKey(path));
  if (!t) return 0;
  const ageDays = ((ctx.now ?? Date.now()) - t) / 86_400_000;
  if (ageDays <= 7) return 20;
  if (ageDays <= 30) return 10;
  return 4;
}

/** 子串/前缀/词首/子序列打分（base 为字段满分）。 */
function matchScore(q: string, field: string, base: number): number {
  if (!field) return 0;
  const i = field.indexOf(q);
  if (i === 0) return base;
  if (i > 0) {
    // 词首命中（前一字符是分隔符）优于普通子串。
    const sep = /[/\-_. ]/.test(field[i - 1]);
    return sep ? base - 12 : base - 30;
  }
  // 子序列：按序出现即可（模糊兜底）。
  let fi = 0;
  for (const ch of q) {
    fi = field.indexOf(ch, fi);
    if (fi < 0) return 0;
    fi++;
  }
  return base - 55;
}

// ---- 索引管理器（IO 编排） ---------------------------------------------------

/** IO 注入面（测试用 mock；生产经平台适配层 platform/）。 */
export interface VaultIndexIO {
  readTextFile(p: string): Promise<string>;
  readDir(d: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  stat(p: string): Promise<{ mtime?: number | null } | null>;
  watch(
    d: string,
    cb: (ev: { type: { kind?: string }; paths: string[] }) => void,
    opts: { recursive: boolean }
  ): Promise<() => void>;
}

const tauriIO: VaultIndexIO = {
  readTextFile: (p) => getAdapter().fs.readTextFile(p),
  readDir: (d) => getAdapter().fs.readDir(d),
  stat: (p) =>
    getAdapter().fs.stat(p).catch(() => null) as unknown as Promise<{ mtime?: number | null } | null>,
  watch: (d, cb, opts) => {
    // 无 watch 能力的平台（鸿蒙 MVP）：拒绝 → rewatch 的 catch 软失败，
    // 索引退化为「保存事件 + 全量扫描」更新。
    const w = getAdapter().fs.watch;
    if (!w) return Promise.reject(new UnsupportedError("当前平台不支持文件监听"));
    return w(d, cb, opts);
  },
};

/** 目录黑名单与扩展名集合（与 workspaceSearch 同规则）。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "out", "build"]);
const MD_EXTS = new Set([".md", ".markdown", ".mdx", ".mdown"]);

export interface VaultStats {
  /** 索引条目数。 */
  total: number;
  /** 正在全量扫描。 */
  scanning: boolean;
  /** 全量扫描进度（非扫描期为 0）。 */
  done: number;
  scanTotal: number;
  /** 索引内容版本（每次变更 +1，订阅方据此刷新）。 */
  version: number;
}

export interface Backlink {
  /** 引用方文件路径。 */
  source: string;
  sourceTitle: string;
  link: VaultLink;
}

export class VaultIndexManager {
  private io: VaultIndexIO;
  private byPath = new Map<string, VaultEntry>();
  private roots: string[] = [];
  private excluded = new Set<string>();
  private unwatchers: Array<() => void> = [];
  /** 全量扫描代次：新扫描作废旧扫描。 */
  private generation = 0;
  private scanning = false;
  private progress = { done: 0, total: 0 };
  private version = 0;
  private listeners = new Set<() => void>();
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;
  private pendingRescans = new Set<string>();
  /** 让路判定（大文档性能模式 + 用户活跃 → 扫描让路）。 */
  shouldYield: () => boolean = () => false;
  /** 功能开关（关闭时不扫描不监听，仅保留已有内存索引）。 */
  enabled = true;

  constructor(io: VaultIndexIO = tauriIO) {
    this.io = io;
  }

  /** 订阅索引变更。返回退订函数。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 单个订阅方异常不影响其它 */
      }
    }
  }

  stats(): VaultStats {
    return {
      total: this.byPath.size,
      scanning: this.scanning,
      done: this.progress.done,
      scanTotal: this.progress.total,
      version: this.version,
    };
  }

  entries(): VaultEntry[] {
    return [...this.byPath.values()];
  }

  entry(path: string): VaultEntry | null {
    return this.byPath.get(pathKey(path)) ?? null;
  }

  /** 随 setRoots 启动的全量扫描 promise（setRootsAndWait 用）。 */
  private rebuildP: Promise<void> = Promise.resolve();

  /** 设置工作区根（触发全量重扫 + 文件监听重挂）。 */
  setRoots(roots: string[], excluded: Set<string> = new Set()): void {
    const changed =
      roots.length !== this.roots.length ||
      roots.some((r, i) => pathKey(r) !== pathKey(this.roots[i]));
    this.roots = roots;
    this.excluded = excluded;
    this.rewatch();
    if (changed || this.byPath.size === 0) {
      this.rebuildP = this.rebuild();
    }
  }

  /** setRoots 的可等待版（测试与诊断用）：等随后的全量扫描完成。 */
  async setRootsAndWait(roots: string[], excluded?: Set<string>): Promise<void> {
    this.setRoots(roots, excluded);
    await this.rebuildP;
  }

  private rewatch(): void {
    for (const un of this.unwatchers) {
      try {
        un();
      } catch {
        /* already gone */
      }
    }
    this.unwatchers = [];
    if (!this.enabled || this.roots.length === 0) return;
    for (const root of this.roots) {
      this.io
        .watch(root, (ev) => this.onWatchEvent(ev), { recursive: true })
        .then((un) => {
          // setRoots 又跑过一轮 → 这是旧的监听，立即拆除。
          if (!this.roots.some((r) => pathKey(r) === pathKey(root))) {
            try {
              un();
            } catch {
              /* gone */
            }
            return;
          }
          this.unwatchers.push(un);
        })
        .catch(() => {
          // 网络盘/权限目录监听失败：软失败（与 useFileWatcher 同策略），
          // 索引仍靠保存事件与下次全量扫描更新。
        });
    }
  }

  private onWatchEvent(ev: { type: { kind?: string }; paths: string[] }): void {
    const kind = ev.type?.kind ?? "any";
    if (kind !== "modify" && kind !== "create" && kind !== "remove" && kind !== "any") return;
    for (const p of ev.paths) {
      if (!MD_EXTS.has(extname(p).toLowerCase())) continue;
      this.pendingRescans.add(toPosix(p));
    }
    if (this.pendingRescans.size === 0) return;
    if (this.watchDebounce != null) globalThis.clearTimeout(this.watchDebounce);
    this.watchDebounce = globalThis.setTimeout(() => {
      this.watchDebounce = null;
      const batch = [...this.pendingRescans];
      this.pendingRescans.clear();
      for (const p of batch) void this.rescanFile(p);
    }, 600);
  }

  /** 全量重建：分批（≤50/批）+ 批间 idle；shouldYield 时持续让路。 */
  async rebuild(): Promise<void> {
    if (!this.enabled || this.roots.length === 0) return;
    const gen = ++this.generation;
    this.scanning = true;
    this.progress = { done: 0, total: 0 };
    this.bump();

    // 收集文件清单（多根共享预算，跳过黑名单/排除项——同 workspaceSearch）。
    const files: string[] = [];
    for (const root of this.roots) {
      await this.collectMdFiles(root, files, gen);
      if (this.generation !== gen) return;
    }
    // 全量重建以本次清单为准：清单外的旧条目删除（根被移除等场景）。
    const keep = new Set(files.map(pathKey));
    for (const k of [...this.byPath.keys()]) {
      if (!keep.has(k)) this.byPath.delete(k);
    }

    this.progress = { done: 0, total: files.length };
    this.bump();

    const BATCH = 50;
    for (let i = 0; i < files.length; i += BATCH) {
      if (this.generation !== gen) return;
      await this.idleYield();
      if (this.generation !== gen) return;
      const batch = files.slice(i, i + BATCH);
      await Promise.all(batch.map((f) => this.scanOne(f)));
      this.progress.done = Math.min(i + BATCH, files.length);
      this.bump();
    }
    this.scanning = false;
    this.bump();
  }

  /** idle 让出（requestIdleCallback 缺席时——node 测试环境——同步放行：
   *  node 无 UI 线程可冻结，无需真正让出；浏览器恒有 ric 走 idle 分支）。 */
  private idleYield(): Promise<void> {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: unknown) => unknown })
      .requestIdleCallback;
    if (!ric) return Promise.resolve();
    return new Promise((resolve) => {
      const step = () => {
        // 用户正在交互（且大文档性能模式开启）→ 索引让路，等下一个 idle 窗口。
        if (this.shouldYield() && isUserActive(2_500)) {
          ric(step, { timeout: 3_000 });
          return;
        }
        resolve();
      };
      ric(step, { timeout: 3_000 });
    });
  }

  private async collectMdFiles(dir: string, out: string[], gen: number): Promise<void> {
    const stack = [dir];
    while (stack.length > 0 && out.length < 10_000) {
      if (this.generation !== gen) return;
      const cur = stack.pop()!;
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try {
        entries = await this.io.readDir(cur);
      } catch {
        continue;
      }
      const dirs: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const full = join(cur, e.name);
        if (this.isExcluded(full)) continue;
        if (e.isDirectory) dirs.push(full);
        else if (MD_EXTS.has(extname(e.name).toLowerCase())) out.push(full);
      }
      dirs.sort((a, b) => -a.localeCompare(b, "en"));
      stack.push(...dirs);
    }
  }

  private isExcluded(p: string): boolean {
    if (this.excluded.size === 0) return false;
    const key = pathKey(p);
    for (const e of this.excluded) {
      const ek = pathKey(e);
      if (key === ek || key.startsWith(ek + "/")) return true;
    }
    return false;
  }

  private async scanOne(path: string): Promise<void> {
    try {
      const [content, st] = await Promise.all([
        this.io.readTextFile(path),
        this.io.stat(path),
      ]);
      if (content.length > 2 * 1024 * 1024) return; // 超大文件跳过（同搜索边界）
      this.upsert(path, content, st?.mtime ?? 0);
    } catch {
      // 读取失败（被删/占用）：从索引中移除。
      if (this.byPath.delete(pathKey(path))) this.bump();
    }
  }

  private upsert(path: string, content: string, mtime: number): void {
    const parsed = parseVaultDoc(content);
    const prev = this.byPath.get(pathKey(path));
    this.byPath.set(pathKey(path), {
      path,
      title: parsed.title ?? titleFromPath(path),
      headings: parsed.headings,
      links: parsed.links,
      tags: parsed.tags,
      flashcards: parsed.flashcards.map((c) => ({ ...c, path })),
      mtime: mtime || prev?.mtime || 0,
    });
  }

  /** 单文件增量重扫（文件监听事件用）。读失败视为删除。 */
  async rescanFile(path: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const [content, st] = await Promise.all([
        this.io.readTextFile(path),
        this.io.stat(path),
      ]);
      if (content.length > 2 * 1024 * 1024) return;
      this.upsert(path, content, st?.mtime ?? 0);
      this.bump();
    } catch {
      if (this.byPath.delete(pathKey(path))) this.bump();
    }
  }

  /**
   * 保存事件：直接用内存内容更新条目（避免回读盘），mtime 尽力补。
   * 验收口径：保存后 3s 内索引更新——本调用同步完成，恒满足。
   */
  noteSaved(path: string, content: string): void {
    if (!this.enabled || !path) return;
    this.upsert(path, content, Date.now());
    this.bump();
  }

  // ---- 查询面 ----------------------------------------------------------------

  /** 反链：引用 `path`（按文件名）的所有来源 + 上下文片段。 */
  backlinksTo(path: string): Backlink[] {
    const stem = stemOf(path);
    if (!stem) return [];
    const out: Backlink[] = [];
    for (const e of this.byPath.values()) {
      for (const link of e.links) {
        if (normalizeTarget(link.target) === stem) {
          out.push({ source: e.path, sourceTitle: e.title, link });
        }
      }
    }
    out.sort((a, b) => a.source.localeCompare(b.source));
    return out;
  }

  /** 全库标签计数（tag → 笔记数，按计数降序）。 */
  allTags(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const e of this.byPath.values()) {
      for (const t of e.tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** 含指定标签的笔记列表。 */
  notesWithTag(tag: string): VaultEntry[] {
    const want = tag.toLowerCase();
    return this.entries().filter((e) =>
      e.tags.some((t) => t.toLowerCase() === want)
    );
  }

  /**
   * 双链目标解析：按文件名（去扩展名）匹配；命中多个时返回全部（调用方
   * 按路径消歧提示选择）。空数组 = 未解析目标。
   */
  resolveWikiTarget(target: string): VaultEntry[] {
    const want = normalizeTarget(target);
    if (!want) return [];
    return this.entries().filter((e) => stemOf(e.path) === want);
  }

  /** 候选补全：名称/标题匹配 `frag` 的条目（[[ 输入补全用，≤limit 条）。 */
  suggestTargets(frag: string, limit = 50): VaultEntry[] {
    const q = frag.trim().toLowerCase();
    const scored: Array<{ e: VaultEntry; s: number }> = [];
    for (const e of this.entries()) {
      const s = Math.max(
        matchScore(q, stemOf(e.path), 100),
        matchScore(q, e.title.toLowerCase(), 80)
      );
      if (s > 0) scored.push({ e, s });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.e);
  }

  dispose(): void {
    this.generation++;
    this.scanning = false;
    for (const un of this.unwatchers) {
      try {
        un();
      } catch {
        /* gone */
      }
    }
    this.unwatchers = [];
    if (this.watchDebounce != null) globalThis.clearTimeout(this.watchDebounce);
    this.watchDebounce = null;
  }
}

function normalizeTarget(t: string): string {
  return t.trim().toLowerCase().replace(/\\/g, "/");
}

/** 全进程共享单例（QuickSwitcher / 反链面板 / RAG 共用一份索引）。 */
export const vaultIndex = new VaultIndexManager();
