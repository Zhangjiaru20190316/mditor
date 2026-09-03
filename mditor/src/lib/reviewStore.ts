// 复习进度的本地持久化（模块 4）：appDataDir/review-state.json。
//
// 本地优先红线：只写应用数据目录；损坏文件静默重建（JSON 解析失败 → 空
// 状态重新开始，绝不崩）；写入防抖合并（连续自评只落一次盘）。
//
// 卡片键 = `${path}\u0000${hash}`（lib/flashcards 的卡片身份）。

import { readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { join } from "./path-shim";
import type { CardSchedule } from "./flashcards";

const FILE_NAME = "review-state.json";
/** 防抖窗口：连续自评合并为一次落盘。 */
const FLUSH_MS = 800;

export interface ReviewState {
  version: 1;
  /** 卡片键 → 调度状态。 */
  cards: Record<string, CardSchedule>;
}

const EMPTY: ReviewState = { version: 1, cards: {} };

/** IO 注入面（测试 mock；生产用 Tauri 插件）。 */
export interface ReviewIO {
  readTextFile(p: string): Promise<string>;
  writeTextFile(p: string, s: string): Promise<void>;
  mkdir(d: string): Promise<void>;
  appDataDir(): Promise<string>;
}

const tauriIO: ReviewIO = {
  readTextFile: (p) => readTextFile(p),
  writeTextFile: (p, s) => writeTextFile(p, s),
  mkdir: (d) => mkdir(d, { recursive: true }),
  appDataDir: () => invoke<string>("app_data_dir"),
};

export function cardKey(path: string, hash: string): string {
  return `${path}\u0000${hash}`;
}

export class ReviewStore {
  private io: ReviewIO;
  private state: ReviewState = { version: 1, cards: {} };
  private filePath: string | null = null;
  private loadP: Promise<void> = Promise.resolve();
  private loaded = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  /** 内存写穿失败（只读盘等）→ true，UI 可提示。 */
  lastError: string | null = null;

  constructor(io: ReviewIO = tauriIO) {
    this.io = io;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 单个订阅方异常不影响其它 */
      }
    }
  }

  /** 首次访问时定位文件并读入（损坏 → 静默重建）。 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return this.loadP;
    this.loadP = this.load();
    return this.loadP;
  }

  private async load(): Promise<void> {
    try {
      const dir = await this.io.appDataDir();
      await this.io.mkdir(dir).catch(() => undefined);
      this.filePath = join(dir, FILE_NAME);
      const raw = await this.io.readTextFile(this.filePath);
      const parsed = JSON.parse(raw) as ReviewState;
      // 宽容校验：cards 形态不对就静默重来（验收：损坏不崩）。
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.cards &&
        typeof parsed.cards === "object"
      ) {
        this.state = { version: 1, cards: parsed.cards };
      } else {
        this.state = { ...EMPTY, cards: {} };
      }
    } catch {
      // 文件不存在（首跑）或损坏：空状态重建，不抛错。
      this.state = { version: 1, cards: {} };
    }
    this.loaded = true;
    this.notify();
  }

  get(key: string): CardSchedule | null {
    return this.state.cards[key] ?? null;
  }

  set(key: string, s: CardSchedule): void {
    this.state.cards[key] = s;
    this.dirty = true;
    this.notify();
    this.scheduleFlush();
  }

  /** 删除卡（源卡被删后的清理）。 */
  remove(key: string): void {
    if (key in this.state.cards) {
      delete this.state.cards[key];
      this.dirty = true;
      this.notify();
      this.scheduleFlush();
    }
  }

  all(): Record<string, CardSchedule> {
    return this.state.cards;
  }

  /** 防抖落盘。 */
  private scheduleFlush(): void {
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    if (!this.loaded) await this.ensureLoaded();
    if (!this.filePath) return;
    try {
      await this.io.writeTextFile(this.filePath, JSON.stringify(this.state));
      this.dirty = false;
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e);
    }
  }

  /** 测试/诊断：重置内存状态（不动盘上文件）。 */
  __resetForTests(): void {
    this.state = { version: 1, cards: {} };
    this.loaded = false;
    this.filePath = null;
    this.dirty = false;
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

/** 全进程共享单例。 */
export const reviewStore = new ReviewStore();
