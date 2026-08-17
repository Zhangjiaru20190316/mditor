// 解析管线编排器（阶段 1 + 阶段 2 的主线程侧）。
//
// 职责：
//   * worker 生命周期（惰性创建 / 超时重建 / 失败静默禁用）；
//   * bindEditor：从 Milkdown ctx 读取 Schema 与 remark 插件表，计算 schema
//     签名并对 worker 管线做**哨兵校验**（插件数对不上 → worker 禁用，
//     回退主线程解析，绝不静默分叉，见 lib/remarkPipeline 的一致性契约）；
//   * prepareDoc：大文档打开/切回前的异步预解析（缓存命中 → worker → 失败
//     返回 false 由调用方走现状同步解析兜底）。产物（文档 JSON）进 docCache，
//     useMilkdown.setValue 命中缓存即零解析应用；
//   * 空闲预解析（阶段 1）：切换收尾后的 idle 窗口里预解析「下一个最可能的
//     目标」（hover 预读项 / 相邻标签），预算严格为 1 个目标，内存紧张
//     （useMemoryGuard 置位压力模式）自动停。
//
// 与遮罩/最短可见时长机制的关系：不变——遮罩仍是缓存未命中 + worker 失败
// 时的兜底反馈；本模块只让"命中"成为大文档切换的常态。

import {
  editorStateOptionsCtx,
  editorViewCtx,
  prosePluginsCtx,
  remarkPluginsCtx,
  schemaCtx,
} from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import { ParserState } from "@milkdown/transformer";

import type { Node as PMNode, Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { expectedPluginCount } from "./remarkPipeline";
import { cacheWorthy, clearDocCache, hasDoc, putDoc, takeDoc } from "./docCache";
import type { ParseReply, ParseRequest } from "./parseShared";

interface EditorBinding {
  schema: Schema;
  schemaSig: string;
  /** 哨兵校验通过（worker 产物与该实例的解析行为等价）。 */
  parityOk: boolean;
}

let binding: EditorBinding | null = null;
let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, (reply: ParseReply) => void>();
// 内存压力模式（useMemoryGuard 置位）：停预解析（含 worker 预解析）。
let pressure = false;
// 空闲预解析的挂起句柄（requestIdleCallback 不可用时退化为 setTimeout）。
let idleHandle: number | null = null;
let idleTimer: number | null = null;

/** 当前绑定实例的 schema 签名；未绑定时返回哨兵值（docCache 一律未命中）。 */
export function schemaSignature(): string {
  return binding?.schemaSig ?? "\u0000unbound";
}

/** worker 路径当前是否可用（已绑定 + 哨兵通过 + worker 未损坏）。 */
export function workerAvailable(): boolean {
  return !!binding?.parityOk && !workerBroken && typeof Worker !== "undefined";
}

/** useMilkdown 在 Crepe 创建成功后调用（重建时同样调用，签名随之更新）。 */
export function bindEditor(ctx: Ctx): void {
  try {
    const schema = ctx.get(schemaCtx);
    const plugins = ctx.get(remarkPluginsCtx) as unknown[];
    binding = {
      schema,
      schemaSig: computeSchemaSig(schema),
      // 哨兵：插件集合与 lib/remarkPipeline 复刻的集合数量一致才放行 worker。
      parityOk: plugins.length === expectedPluginCount(!!schema.nodes.math_inline),
    };
  } catch {
    binding = null;
  }
}

/** 编辑器销毁时解除绑定（缓存条目靠签名惰性失效，无需清理）。 */
export function unbindEditor(): void {
  binding = null;
}

function computeSchemaSig(schema: Schema): string {
  const nodes = Object.keys(schema.nodes).sort().join(",");
  const marks = Object.keys(schema.marks).sort().join(",");
  return `n[${nodes}]m[${marks}]`;
}

// ---- worker ------------------------------------------------------------

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/parseWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<ParseReply>) => {
      const reply = e.data;
      const resolve = pending.get(reply.id);
      if (!resolve) return;
      pending.delete(reply.id);
      resolve(reply);
    };
    worker.onerror = () => {
      // worker 脚本加载失败（CSP / 打包问题）：禁用并唤醒所有等待者走兜底。
      workerBroken = true;
      dropWorker();
      for (const resolve of pending.values()) resolve({ id: -1, ok: false, error: "worker-error" });
      pending.clear();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function dropWorker(): void {
  try {
    worker?.terminate();
  } catch {
    /* already gone */
  }
  worker = null;
}

/** worker 解析（超时按体量缩放；超时即重建 worker 并失败返回 null）。 */
function parseInWorker(content: string, withMath: boolean): Promise<unknown | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const id = ++seq;
  const bytes = new TextEncoder().encode(content);
  // 经验上限：1MB ≈ 9.5s（worker 里 tokenize 明显快于主线程，此为安全网）。
  const timeoutMs = Math.min(10_000, 2_500 + Math.floor(content.length / 120));
  return new Promise<unknown | null>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      // 卡死的 worker 不再信任：终止重建，本次走兜底。
      dropWorker();
      resolve(null);
    }, timeoutMs);
    pending.set(id, (reply) => {
      window.clearTimeout(timer);
      resolve(reply.ok ? reply.tree ?? null : null);
    });
    const msg: ParseRequest = { id, bytes: bytes.buffer, withMath };
    w.postMessage(msg, [bytes.buffer]);
  });
}

// ---- mdast → ProseMirror 轻量映射 --------------------------------------

/** worker 树里 schema 不认识的节点类型（如 math 关闭时的公式）→ 放弃映射，
 *  由调用方回退主线程解析（原地管线的 remark 同样没有 math，不会产生这些
 *  节点，行为回到一致）。 */
function treeHasUnknownMath(tree: unknown): boolean {
  if (!tree || typeof tree !== "object") return false;
  const n = tree as { type?: string; children?: unknown[] };
  if (n.type === "math" || n.type === "inlineMath") return true;
  return (n.children ?? []).some(treeHasUnknownMath);
}

/** 把 worker 产出的 mdast 树映射为当前 schema 的 ProseMirror 文档。
 *  映射失败（未知节点 / schema 不匹配）返回 null，调用方回退原地解析。 */
export function mapTreeToDoc(tree: unknown): PMNode | null {
  const b = binding;
  if (!b || !tree) return null;
  try {
    if (!b.schema.nodes.math_inline && treeHasUnknownMath(tree)) return null;
    // 与 @milkdown/transformer ParserState.run→toDoc 等价的路径，只是树来自
    // worker 而不是本线程的 remark。
    const state = new ParserState(b.schema);
    state.next(tree as never);
    return state.toDoc();
  } catch {
    return null;
  }
}

// ---- 预解析 --------------------------------------------------------------

/**
 * 确保大文档的解析产物已在缓存中（打开 / 切回前的 await 点）。
 * 幂等：已缓存立即返回 true；worker 不可用 / 失败 / 过期（isCurrent 为假）
 * 返回 false——调用方照常走同步 setValue（原地解析 + 回填缓存），遮罩兜底。
 */
export async function prepareDoc(
  content: string,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  const b = binding;
  if (!b || !cacheWorthy(content)) return false;
  if (hasDoc(content, b.schemaSig)) return true;
  if (!workerAvailable()) return false;
  const tree = await parseInWorker(content, !!b.schema.nodes.math_inline);
  if (!tree || !isCurrent()) return false;
  const doc = mapTreeToDoc(tree);
  if (!doc) return false;
  putDoc(content, doc.toJSON(), b.schemaSig);
  return true;
}

// ---- 空闲预解析（阶段 1）--------------------------------------------------

/** 取消挂起的空闲预解析（新切换开始时调用，避免与真实加载争抢 worker）。 */
export function cancelIdlePreparse(): void {
  if (idleHandle != null && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(idleHandle);
  }
  if (idleTimer != null) window.clearTimeout(idleTimer);
  idleHandle = null;
  idleTimer = null;
}

/**
 * 切换收尾后安排一次空闲预解析：idle 窗口里向 getTarget 要「下一个最可能
 * 的目标」（调用方决定优先级：hover 预读 > 相邻标签），预算严格 1 个。
 * 目标不是大文档 / 已缓存 / 内存压力中 → 直接放弃，不空转。
 */
export function scheduleIdlePreparse(getTarget: () => string | null): void {
  cancelIdlePreparse();
  if (pressure || !workerAvailable()) return;
  const run = () => {
    idleHandle = null;
    idleTimer = null;
    const content = (() => {
      try {
        return getTarget();
      } catch {
        return null;
      }
    })();
    if (!content || !cacheWorthy(content)) return;
    if (hasDoc(content, schemaSignature())) return;
    void prepareDoc(content);
  };
  if (typeof requestIdleCallback === "function") {
    idleHandle = requestIdleCallback(run, { timeout: 2_000 });
  } else {
    idleTimer = window.setTimeout(run, 800);
  }
}

// ---- 内存守护接入 ---------------------------------------------------------

/**
 * useMemoryGuard 每 tick 调用：over=true（堆超阈值）时清空解析缓存并停
 * 预解析——这是比重建编辑器廉价得多的回收手段；over=false 恢复。
 * 返回清掉的条目数（诊断日志用）。
 */
export function setMemoryPressure(over: boolean): number {
  const cleared = over ? clearDocCache() : 0;
  if (over) cancelIdlePreparse();
  pressure = over;
  return cleared;
}

// ---- useMilkdown 共用的「零解析应用」--------------------------------------

/**
 * 把（缓存来的或 worker 映射出的）ProseMirror 文档直接装进视图——与
 * @milkdown/utils replaceAll(md, true) 的 flush 分支完全同构：EditorState
 * 重建（历史清空）+ view.updateState。省掉的只有 parserCtx 的全文解析。
 */
export function applyParsedDoc(ctx: Ctx, doc: PMNode): void {
  const view = ctx.get(editorViewCtx);
  const schema = ctx.get(schemaCtx);
  const options = ctx.get(editorStateOptionsCtx)({
    schema,
    doc,
    plugins: ctx.get(prosePluginsCtx),
  });
  view.updateState(EditorState.create(options));
}

/** 缓存快路径取件（useMilkdown.setValue 用）：未绑定 / 不值得缓存 /
 *  未命中 / schema 签名不符 → null。 */
export function takeCachedDoc(content: string): unknown | null {
  const b = binding;
  if (!b || !cacheWorthy(content)) return null;
  return takeDoc(content, b.schemaSig);
}

/** 供 useMilkdown 原地解析后回填缓存（只回填大文档）。 */
export function cacheParsedDoc(content: string, doc: PMNode): void {
  const b = binding;
  if (!b || !cacheWorthy(content)) return;
  try {
    putDoc(content, doc.toJSON(), b.schemaSig);
  } catch {
    /* toJSON 极端失败——缓存放弃，不影响编辑 */
  }
}
