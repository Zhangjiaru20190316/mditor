// RAG 向量索引管理器（模块 5，v4.7）：分块 → 嵌入 → 余弦检索。
//
// 本地优先红线：向量索引只存 appDataDir/rag-index.json（嵌入模型与全部
// 向量留在本地，不上传、无遥测）；嵌入请求经注入面（生产 = lib/ai.embedTexts
// → Rust ai_embed 代理），渲染层不直连外网。
//
// 增量更新（两层去重）：
//   * 文件级：vaultIndex 条目的 mtime 未变 → 跳过读盘；
//   * 块级：块 id 已有向量 → 不重复嵌入（保存导致的 mtime 抖动只重读文本，
//     改动块才重新计费）。
//
// 构建调度：分批（≤16 块/批）嵌入，批间检查 paused/generation——暂停即落盘
// 保留进度，续跑从未嵌入的块继续；失败落盘保留已建部分并记录 error。
// bigDocPerformance 开启 + 用户活跃时让路（同 vaultIndex 的 shouldYield 纪律）。

import { getAdapter } from "../platform";
import { join } from "./path-shim";
import { isUserActive } from "./activity";
import type { Settings } from "../types";
import { chunkDocument, topKBySimilarity, type RagChunk, type ScoredChunk } from "./rag";

const FILE_NAME = "rag-index.json";
/** 每批嵌入的块数（OpenAI /embeddings 单请求上限内的保守值）。 */
const EMBED_BATCH = 16;
/** 向量精度（小数位）——JSON 体积与检索精度折中。 */
const VECTOR_PRECISION = 4;

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

interface StoredChunkMeta {
  path: string;
  heading: string;
  text: string;
  line: number;
  /** 块内容哈希——同 id（行号）内容变化时判定需要重嵌。 */
  hash: string;
}

interface RagDocRecord {
  mtime: number;
  chunks: string[];
}

interface RagIndexFile {
  version: 1;
  /** 建索引时的嵌入模型（换模型自动全量重建）。 */
  model: string;
  docs: Record<string, RagDocRecord>;
  /** 块 id → 元数据（检索时拼上下文用）。 */
  chunkMetas: Record<string, StoredChunkMeta>;
  /** 块 id → 向量。 */
  vectors: Record<string, number[]>;
}

export interface RagProgress {
  phase: "idle" | "building" | "paused" | "done" | "error";
  done: number;
  total: number;
  error: string | null;
}

/** IO 注入面（测试 mock；生产用 Tauri 插件）。 */
export interface RagIO {
  readTextFile(p: string): Promise<string>;
  writeTextFile(p: string, s: string): Promise<void>;
  mkdir(d: string): Promise<void>;
  appDataDir(): Promise<string>;
  /** D3 原子替换用；缺省（旧测试桩）时 persist 退化为直写。 */
  rename?(a: string, b: string): Promise<void>;
}

const tauriIO: RagIO = {
  readTextFile: (p) => getAdapter().fs.readTextFile(p),
  writeTextFile: (p, s) => getAdapter().fs.writeTextFile(p, s),
  mkdir: (d) => getAdapter().fs.mkdir(d, { recursive: true }),
  appDataDir: () => getAdapter().app.appDataDir(),
  rename: (a, b) => getAdapter().fs.rename(a, b),
};

export class RagIndexManager {
  private io: RagIO;
  private model = "";
  private docs: Record<string, RagDocRecord> = {};
  private vectors: Record<string, number[]> = {};
  private chunkMetas: Record<string, StoredChunkMeta> = {};
  private filePath: string | null = null;
  private loaded = false;
  private loadP: Promise<void> = Promise.resolve();
  /** 构建代次：新构建作废旧构建。 */
  private generation = 0;
  paused = false;
  progress: RagProgress = { phase: "idle", done: 0, total: 0, error: null };
  private listeners = new Set<() => void>();
  /** 让路判定（big 模式 + 用户活跃 → 嵌入批次让路）。 */
  shouldYield: () => boolean = () => false;

  constructor(io: RagIO = tauriIO) {
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

  stats(): RagProgress & { chunks: number; docs: number; model: string } {
    return {
      ...this.progress,
      chunks: Object.keys(this.vectors).length,
      docs: Object.keys(this.docs).length,
      model: this.model,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return this.loadP;
    this.loadP = this.load();
    return this.loadP;
  }

  /** 公开预热：从盘载入索引（App 在 ragEnabled 时调用；search/isBuilt 只读
   *  内存，不触发 IO）。 */
  async ensureReady(): Promise<void> {
    return this.ensureLoaded();
  }

  private async load(): Promise<void> {
    try {
      const dir = await this.io.appDataDir();
      await this.io.mkdir(dir).catch(() => undefined);
      this.filePath = join(dir, FILE_NAME);
      const parsed = JSON.parse(await this.io.readTextFile(this.filePath)) as RagIndexFile;
      if (parsed && parsed.version === 1 && parsed.vectors && parsed.docs && parsed.chunkMetas) {
        this.model = typeof parsed.model === "string" ? parsed.model : "";
        this.docs = parsed.docs;
        this.vectors = parsed.vectors;
        this.chunkMetas = parsed.chunkMetas;
      }
    } catch {
      // 首跑/损坏：静默重建空索引（铁律同 review-state）。
      this.docs = {};
      this.vectors = {};
      this.chunkMetas = {};
      this.model = "";
    }
    this.loaded = true;
  }

  /**
   * 全量/续跑构建。`entries` 来自 vaultIndex（path/title/mtime），`embed`
   * 为嵌入函数（生产注入 ai.embedTexts）。返回是否完整跑完（暂停/失败为
   * false，已嵌入部分已落盘可续跑）。
   */
  async build(
    entries: Array<{ path: string; title: string; mtime: number }>,
    settings: Pick<Settings, "ragEmbedModel">,
    embed: EmbedFn
  ): Promise<boolean> {
    await this.ensureLoaded();
    // 换模型 → 全量重建（旧向量语义空间不兼容）。
    if (this.model && this.model !== settings.ragEmbedModel) {
      this.docs = {};
      this.vectors = {};
      this.chunkMetas = {};
    }
    this.model = settings.ragEmbedModel;

    const gen = ++this.generation;
    this.paused = false;
    this.progress = { phase: "building", done: 0, total: 0, error: null };
    this.notify();

    // 第一遍：读盘 + 分块（文件级 mtime 跳过）。
    interface Job {
      docPath: string;
      mtime: number;
      chunks: RagChunk[];
    }
    const pending: Job[] = [];
    let total = 0;
    for (const entry of entries) {
      if (gen !== this.generation) return false;
      const prev = this.docs[entry.path];
      if (prev && prev.mtime === entry.mtime && (prev.chunks?.length ?? 0) > 0) continue;
      let content: string;
      try {
        content = await this.io.readTextFile(entry.path);
      } catch {
        continue; // 读失败（被删/占用）：跳过该文件
      }
      if (content.length > 2 * 1024 * 1024) continue; // 超大文件不进 RAG
      const chunks = chunkDocument(entry.title, content, entry.path);
      if (chunks.length === 0) continue;
      pending.push({ docPath: entry.path, mtime: entry.mtime, chunks });
      total += chunks.length;
    }
    this.progress.total = total;
    this.notify();
    let done = 0;

    const pauseCheck = async (): Promise<boolean> => {
      if (!this.paused) return false;
      this.progress = { ...this.progress, phase: "paused" };
      await this.persist();
      this.notify();
      return true;
    };

    // 第二遍：逐文件逐批嵌入（块级 id+hash 双校验去重 + 可暂停/续跑）。
    for (const job of pending) {
      if (gen !== this.generation) return false;
      if (await pauseCheck()) return false;
      const keptIds: string[] = [];
      const newChunks: RagChunk[] = [];
      for (const c of job.chunks) {
        // 去重条件：同 id 已有向量 **且** 内容哈希未变（同位置编辑过 → 重嵌）。
        if (this.vectors[c.id] && this.chunkMetas[c.id]?.hash === c.hash) keptIds.push(c.id);
        else newChunks.push(c);
        this.chunkMetas[c.id] = {
          path: c.path,
          heading: c.heading,
          text: c.text,
          line: c.line,
          hash: c.hash,
        };
      }
      // 注意：docs 记录（mtime 门）只在该文件全部新块嵌入成功后写入——
      // 中途暂停/失败时下次重读该文件，已嵌入块凭 id+hash 直接复用（零计费）。

      for (let i = 0; i < newChunks.length; i += EMBED_BATCH) {
        if (gen !== this.generation) return false;
        if (await pauseCheck()) return false;
        // 让路：big 模式 + 用户活跃 → 等待下一个空闲窗口。
        while (this.shouldYield() && isUserActive(2_500)) {
          if (gen !== this.generation) return false;
          if (await pauseCheck()) return false;
          await sleep(3_000);
        }
        const batch = newChunks.slice(i, i + EMBED_BATCH);
        try {
          const vecs = await embed(batch.map((c) => c.text));
          if (vecs.length !== batch.length) {
            throw new Error(`嵌入返回 ${vecs.length} 条（期望 ${batch.length}）`);
          }
          batch.forEach((c, j) => {
            this.vectors[c.id] = roundVector(vecs[j]);
          });
        } catch (e) {
          this.progress = { ...this.progress, phase: "error", error: String(e) };
          await this.persist();
          this.notify();
          return false;
        }
        done += batch.length;
        this.progress.done = done;
        this.notify();
      }

      // 该文件全部块就绪：提交 docs 记录（mtime 门自此生效）。
      this.docs[job.docPath] = {
        mtime: job.mtime,
        chunks: job.chunks.map((c) => c.id),
      };
    }

    this.progress = { phase: "done", done, total, error: null };
    await this.persist();
    this.notify();
    return true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(
    entries: Array<{ path: string; title: string; mtime: number }>,
    settings: Pick<Settings, "ragEmbedModel">,
    embed: EmbedFn
  ): Promise<boolean> {
    return this.build(entries, settings, embed);
  }

  async persist(): Promise<void> {
    await this.ensureLoaded();
    if (!this.filePath) return;
    const file: RagIndexFile = {
      version: 1,
      model: this.model,
      docs: this.docs,
      chunkMetas: this.chunkMetas,
      vectors: this.vectors,
    };
    try {
      // D3 同款原子写：先写 .tmp 再 rename 替换——截断式直写在崩溃/断电
      // 中途会留下半份 JSON，下次加载解析失败 → 整库索引无谓重建。
      const tmp = `${this.filePath}.tmp`;
      const payload = JSON.stringify(file);
      await this.io.writeTextFile(tmp, payload);
      if (this.io.rename) {
        await this.io.rename(tmp, this.filePath);
      } else {
        await this.io.writeTextFile(this.filePath, payload);
      }
    } catch {
      /* 落盘失败保留内存索引（下次构建重写） */
    }
  }

  /** 检索：问题向量 → top-k 块（含元数据文本）。 */
  search(queryVector: number[], k = 8): ScoredChunk[] {
    const entries: Array<{ chunk: RagChunk; vector: number[] }> = [];
    for (const [id, vector] of Object.entries(this.vectors)) {
      const meta = this.chunkMetas[id];
      if (!meta) continue;
      entries.push({
        chunk: {
          id,
          path: meta.path,
          heading: meta.heading,
          text: meta.text,
          hash: id,
          line: meta.line,
        },
        vector,
      });
    }
    return topKBySimilarity(queryVector, entries, k);
  }

  /** 是否已建过索引（docs 非空且模型匹配）。 */
  isBuilt(model: string): boolean {
    return this.model === model && Object.keys(this.docs).length > 0;
  }

  __resetForTests(): void {
    this.docs = {};
    this.vectors = {};
    this.chunkMetas = {};
    this.model = "";
    this.generation++;
    this.paused = false;
    this.progress = { phase: "idle", done: 0, total: 0, error: null };
  }
}

function roundVector(v: number[]): number[] {
  const p = 10 ** VECTOR_PRECISION;
  return v.map((x) => Math.round(x * p) / p);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 全进程共享单例。 */
export const ragIndex = new RagIndexManager();
