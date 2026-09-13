// 文献库管理（模块 3）：设置里的 .bib 路径 → 内存 BibEntry 表。
//
// 模块级单例（同 mathConfig 惯例）：useSettings 在设置加载/更新时同步调用
// setStyle / setPath；加载（读盘 + parseBibtex）异步进行，完成后 version+1
// 并通知订阅方（编辑器 widget / 引用选择器刷新）。renderMarkdown 的缓存键
// 含 signature()，配置或文献变化后静态渲染立即生效。
//
// 本地优先：.bib 只在用户显式选择的路径上读取，解析结果仅存内存。

import { getAdapter } from "../platform";
import { parseBibtex, type BibEntry } from "./bibtex";
import type { CitationStyle } from "./citation";

/** IO 注入面（测试 mock；生产经平台适配层 platform/）。 */
export interface BibIO {
  readTextFile(p: string): Promise<string>;
}

const tauriIO: BibIO = { readTextFile: (p) => getAdapter().fs.readTextFile(p) };

export class BibliographyManager {
  private io: BibIO;
  private path = "";
  private entries: BibEntry[] = [];
  private errors: string[] = [];
  private style: CitationStyle = "numeric";
  /** 加载代次：路径变化后旧加载作废。 */
  private generation = 0;
  private loadP: Promise<void> = Promise.resolve();
  /** 内容版本（成功加载 +1），订阅方据此刷新。 */
  version = 0;
  private listeners = new Set<() => void>();

  constructor(io: BibIO = tauriIO) {
    this.io = io;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 单个订阅方异常不影响其它 */
      }
    }
  }

  /** 引用样式（useSettings 同步维护；进 signature）。 */
  setStyle(style: CitationStyle): void {
    if (this.style === style) return;
    this.style = style;
    this.notify();
  }

  getStyle(): CitationStyle {
    return this.style;
  }

  /**
   * 设置 .bib 路径并（异步）加载。空串 = 关闭文献功能（清空表）。路径未变
   * 时不重复读盘。返回加载 promise（测试/诊断用）。
   */
  setPath(path: string): Promise<void> {
    const want = path.trim();
    if (want === this.path) return this.loadP;
    this.path = want;
    if (!want) {
      this.entries = [];
      this.errors = [];
      this.notify();
      this.loadP = Promise.resolve();
      return this.loadP;
    }
    const gen = ++this.generation;
    this.loadP = this.load(gen, want);
    return this.loadP;
  }

  /** 强制重载（外部修改 .bib 后的「刷新」入口）。 */
  reload(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const gen = ++this.generation;
    this.loadP = this.load(gen, this.path);
    return this.loadP;
  }

  /**
   * 直接装载 .bib 文本（同步）：setPath 读盘完成后的内部落地，亦供测试
   * 与「拖入 .bib 导入」等无盘路径复用。解析容错同 parseBibtex。
   */
  loadText(path: string, src: string): void {
    this.path = path;
    const { entries, errors } = parseBibtex(src);
    this.entries = entries;
    this.errors = errors;
    this.notify();
  }

  private async load(gen: number, path: string): Promise<void> {
    let src: string;
    try {
      src = await this.io.readTextFile(path);
    } catch (e) {
      if (gen !== this.generation) return;
      this.entries = [];
      this.errors = [`文献库读取失败：${String(e)}`];
      this.notify();
      return;
    }
    if (gen !== this.generation) return;
    this.loadText(path, src);
  }

  /** 当前路径。 */
  getPath(): string {
    return this.path;
  }

  all(): BibEntry[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  /** 大小写不敏感检索。 */
  get(key: string): BibEntry | null {
    const want = key.trim().toLowerCase();
    return this.entries.find((e) => e.key.toLowerCase() === want) ?? null;
  }

  getErrors(): string[] {
    return [...this.errors];
  }

  /** 引用选择器检索：citekey / 标题 / 作者 / 年份子串命中（≤limit 条）。 */
  search(q: string, limit = 30): BibEntry[] {
    const query = q.trim().toLowerCase();
    if (!query) return this.entries.slice(0, limit);
    const scored: Array<{ e: BibEntry; s: number }> = [];
    for (const e of this.entries) {
      const key = e.key.toLowerCase();
      const title = (e.fields.title ?? "").toLowerCase();
      const author = (e.fields.author ?? e.fields.editor ?? "").toLowerCase();
      const year = e.fields.year ?? "";
      let s = 0;
      if (key === query) s = 100;
      else if (key.startsWith(query)) s = 90;
      else if (key.includes(query)) s = 70;
      else if (title.includes(query)) s = 60;
      else if (author.includes(query)) s = 50;
      else if (year.includes(query)) s = 30;
      if (s > 0) scored.push({ e, s });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.e);
  }

  /** 配置签名（renderMarkdown 缓存键）：路径 + 内容版本 + 样式。 */
  signature(): string {
    return `${this.path}|v${this.version}|${this.style}`;
  }
}

/** 全进程共享单例（设置 / 编辑器 / 选择器 / 静态渲染共用一份）。 */
export const bibliography = new BibliographyManager();
