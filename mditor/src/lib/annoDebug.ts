// 批注诊断体系（v3.9.3）——事件总线 + 计数器 + 体检。
//
// 背景：批注「徽章无编号 / 代码块连片闪」已连续三轮修复仍复发，根因都
// 藏在「定点写失败 → 整篇回退 → 全部节点视图重建」这条链上，但每次都缺
// 少运行时证据（warn 限频刷屏、无法区分失败原因分布、看不到整篇回退的
// 真实频率）。本模块把批注全链路的关键事件收进环形缓冲 + 计数器：
//   * 事件流 —— AnnoDiagnostics 面板实时显示（设置开关 / Ctrl+Alt+D）；
//   * 计数器 —— 「整篇重写次数」「定点跳帧原因分布」一眼定位是否又进入
//     回退循环；
//   * 体检（runAnnoHealthCheck）—— 用**真实 Milkdown 解析器**逐条验证
//     当前文档的批注定义形态（standalone 解析 / 序列化往返），历史上
//     字符串级测试全绿但真实解析器丢弃定义形态的事故（v3.6.6 / v3.9.2）
//     由此常驻可查。
//
// 纪律：诊断代码绝不能影响编辑器——所有公开入口 try/catch，订阅回调
// 异常自动摘除；窗口导出仅作控制台排查便利。

import { buildDefinition, parseAnnotations, type Annotation } from "./annotations";
import { stripCodeLineMeta } from "./codeAnno";

/** 事件级别（面板按级别着色）。 */
export type AnnoDebugLevel = "info" | "warn" | "error";

/** 一条诊断事件。`kind` 用 `域:动作` 命名（如 `stream:skip`、`full:rewrite`）。 */
export interface AnnoDebugEvent {
  ts: number;
  level: AnnoDebugLevel;
  kind: string;
  msg: string;
  data?: Record<string, unknown>;
}

/** 环形缓冲容量：流式期间每帧可能 1-2 条，300 条覆盖完整一次生成。 */
const EVENT_CAPACITY = 300;

const events: AnnoDebugEvent[] = [];
const counters = new Map<string, number>();
const subscribers = new Set<(e: AnnoDebugEvent) => void>();

/** 计数器 +1（或 +n）。key 惯例 `域.名`，如 `full.rewrite`、`stream.skip.no-parse`。 */
export function annoCount(key: string, n = 1): void {
  try {
    counters.set(key, (counters.get(key) ?? 0) + n);
  } catch {
    /* never throw */
  }
}

/** 发一条事件（自动 annoCount(kind)）。诊断链路永不抛错。 */
export function annoEmit(
  kind: string,
  msg: string,
  opts: { level?: AnnoDebugLevel; data?: Record<string, unknown>; count?: number } = {}
): void {
  try {
    const e: AnnoDebugEvent = {
      ts: Date.now(),
      level: opts.level ?? "info",
      kind,
      msg,
      data: opts.data,
    };
    events.push(e);
    if (events.length > EVENT_CAPACITY) events.shift();
    annoCount(kind, opts.count);
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch {
        subscribers.delete(fn);
      }
    }
  } catch {
    /* never throw */
  }
}

/** 订阅新事件（面板用）。返回退订函数。 */
export function annoSubscribe(fn: (e: AnnoDebugEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 事件快照（新到旧倒序由面板自行排）。 */
export function annoEvents(): readonly AnnoDebugEvent[] {
  return events;
}

/** 计数器快照（按 key 排序，展示稳定）。 */
export function annoCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Array.from(counters.entries()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[k] = v;
  }
  return out;
}

/** 清空事件与计数器（面板「清空」按钮）。 */
export function annoDebugClear(): void {
  events.length = 0;
  counters.clear();
}

/* -------------------------------------------------------------------------- */
/* 编辑器探针（useMilkdown 注册；体检与诊断面板据此访问真实 ProseMirror 状态） */
/* -------------------------------------------------------------------------- */

/** 由 useMilkdown 在每次 crepe 创建后注册的探针（销毁时置 null）。 */
export interface AnnoEditorProbe {
  /** 当前 ProseMirror 文档中是否存在该 id 的 footnote_definition 节点。 */
  hasDefInDoc(id: string): boolean;
  /** 用真实 Milkdown 解析器 standalone 解析定义文本，能否得到该 id 的
   *  footnote_definition（no-parse 根因检测——replaceDefinitionOp 走的
   *  正是这条路）。 */
  parseStandalone(defText: string, id: string): boolean;
  /** 序列化当前文档中该 id 的定义节点（无节点 → null）。用于往返比对。 */
  serializeDef(id: string): string | null;
}

let probe: AnnoEditorProbe | null = null;

export function registerAnnoProbe(p: AnnoEditorProbe | null): void {
  probe = p;
}

export function getAnnoProbe(): AnnoEditorProbe | null {
  return probe;
}

/* -------------------------------------------------------------------------- */
/* PM 观察器暂停门（盖章战争根修，v3.9.3）                                       */
/* -------------------------------------------------------------------------- */

/**
 * 盖章战争的机制（harness 实测 17Hz 死循环）：往 ProseMirror 管辖的 DOM
 * （marker <sup> 的 data-anno-num、marker 段落的 anno-row-item class、
 * 图片的 loading/aspect-ratio）写入属性 → PM 的 DOMObserver 把它当外来
 * 突变 → 从 toDOM 重渲染该节点（属性被抹掉）→ 我们的 MO 看到 sup 重建
 * → 60ms 防抖后再盖章 → 循环永不停止（1000/60 ≈ 17 次/秒，与实测的空闲
 * 期每秒 17 次徽章重建完全吻合）。徽章无编号/悬停闪烁/marker 段落 17Hz
 * 块级↔行内振荡（下方代码块连片闪的驱动源）全部由此而来。
 *
 * 根修：所有「写 PM 管辖 DOM」的盖章动作都包进 observer 暂停窗口——
 * domObserver.stop() 后写入不产生任何 MutationRecord，start() 会丢弃
 * 挂起记录，PM 根本看不见这些写入，永不触发防御性重渲染。注册方：
 * useMilkdown（每次 crepe 重建重绑）；未注册时直通执行（无伤降级）。
 */
type PmObserverGate = (fn: () => void) => void;

let pmGate: PmObserverGate | null = null;

export function registerPmObserverGate(g: PmObserverGate | null): void {
  pmGate = g;
}

/** 在 PM DOMObserver 暂停窗口内执行 `fn`（用于写 PM 管辖的 DOM）。 */
export function withPmObserverPaused(fn: () => void): void {
  if (pmGate) {
    try {
      pmGate(fn);
      return;
    } catch {
      /* fall through to direct execution */
    }
  }
  fn();
}

/* -------------------------------------------------------------------------- */
/* 批注体检（纯逻辑可单测；DOM 探测在无 document 环境降级为 null）              */
/* -------------------------------------------------------------------------- */

export type HealthVerdict = "pass" | "fail" | "n/a";

/** 一条批注的体检结果。所有「解析不出/找不到」都要能从字段直接读出原因。 */
export interface AnnoHealthRow {
  id: string;
  /** 文本层：parseAnnotations 在 markdown 里找到定义。 */
  defInMd: boolean;
  /** 节点层：ProseMirror 文档里有定义节点（探针缺席 → null=未测）。 */
  defInDoc: HealthVerdict;
  /** DOM 层：渲染出了 marker 徽章。 */
  markerInDom: HealthVerdict;
  /** DOM 层：徽章带 data-anno-num（编号可见的前提）。 */
  numStamped: HealthVerdict;
  /** buildDefinition 产物经真实解析器 standalone 解析（no-parse 根因）。 */
  standaloneParse: HealthVerdict;
  /** 文档中定义节点序列化 → 再解析 → 内容等价（往返丢失检测）。 */
  roundTrip: HealthVerdict;
  /** 形态摘要：行数 + 首行 60 字符——定位「哪种体解析失败」。 */
  shape: string;
  /** fail 时的补充说明（面板展示，导出留档）。 */
  notes: string[];
}

const MARKER_SEL = 'sup[data-type="footnote_reference"]';

function shapeOf(content: string): string {
  const lines = content.split("\n");
  const first = (lines[0] || "").slice(0, 60) || "（空）";
  return lines.length > 1 ? `${lines.length} 行｜首行: ${first}` : `单行: ${first}`;
}

/** 空白归一的正文比对（序列化器的缩进/空白差异不算内容变化）。 */
function normalizeBody(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 对整份 markdown 的每条批注做分层体检（文本层 → PM 节点层 → DOM 层 →
 * 真实解析器层）。纯数据进出（DOM 探测在无 document 时降级），返回逐条
 * 结果；同时把 fail 项发进事件流留档。
 */
export function runAnnoHealthCheck(md: string): AnnoHealthRow[] {
  const rows: AnnoHealthRow[] = [];
  let annos: Annotation[];
  try {
    annos = parseAnnotations(md);
  } catch {
    annoEmit("health.error", "parseAnnotations 抛错", { level: "error" });
    return rows;
  }
  const p = probe;
  const hasDom = typeof document !== "undefined";
  for (const a of annos) {
    const notes: string[] = [];
    // 文本层：parseAnnotations 找到了定义才有这条记录本身。
    // 节点层：PM 文档里有没有定义节点（被解析丢弃 = no-def 根因）。
    let defInDoc: HealthVerdict = "n/a";
    if (p) {
      try {
        defInDoc = p.hasDefInDoc(a.id) ? "pass" : "fail";
        if (defInDoc === "fail") notes.push("定义节点不在 ProseMirror 文档（被解析丢弃 → no-def）");
      } catch {
        notes.push("hasDefInDoc 探针异常");
      }
    } else {
      notes.push("编辑器探针未注册（非富文本模式/未就绪）");
    }
    // DOM 层：marker 徽章与编号。
    let markerInDom: HealthVerdict = "n/a";
    let numStamped: HealthVerdict = "n/a";
    if (hasDom) {
      try {
        const el = document.querySelector<HTMLElement>(
          `${MARKER_SEL}[data-label="${a.id}"]`
        );
        markerInDom = el ? "pass" : "fail";
        if (markerInDom === "fail") {
          notes.push("徽章未渲染（标记被删/中间态重建窗口）");
          numStamped = "fail";
        } else {
          numStamped = el?.hasAttribute("data-anno-num") ? "pass" : "fail";
          if (numStamped === "fail") notes.push("data-anno-num 缺失（编号不显示）");
        }
      } catch {
        notes.push("DOM 探测异常");
      }
    }
    // 真实解析器层①：buildDefinition 形态 standalone 解析。
    let standaloneParse: HealthVerdict = "n/a";
    let defText = "";
    if (p) {
      try {
        defText = buildDefinition(a.id, a.content, a.codeLine);
        standaloneParse = p.parseStandalone(defText, a.id) ? "pass" : "fail";
        if (standaloneParse === "fail") {
          notes.push("buildDefinition 形态 standalone 解析失败（no-parse 根因）");
        }
      } catch {
        standaloneParse = "fail";
        notes.push("parseStandalone 探针抛错");
      }
    }
    // 真实解析器层②：文档中定义节点序列化 → 再解析 → 内容等价。
    let roundTrip: HealthVerdict = "n/a";
    if (p && defInDoc === "pass") {
      try {
        const ser = p.serializeDef(a.id);
        if (ser == null) {
          roundTrip = "fail";
          notes.push("定义节点序列化失败");
        } else if (!p.parseStandalone(ser, a.id)) {
          roundTrip = "fail";
          notes.push("序列化形态 standalone 再解析失败（编辑保存会触发同样路径）");
        } else {
          const back = parseAnnotations(ser).find((x) => x.id === a.id);
          const norm = (s: string) => normalizeBody(stripCodeLineMeta(s).content);
          roundTrip = back && norm(back.content) === norm(a.content) ? "pass" : "fail";
          if (roundTrip === "fail") {
            notes.push("序列化往返内容不等价（可能截断多行体）");
          }
        }
      } catch {
        roundTrip = "fail";
        notes.push("roundTrip 探针异常");
      }
    }
    const row: AnnoHealthRow = {
      id: a.id,
      defInMd: true,
      defInDoc,
      markerInDom,
      numStamped,
      standaloneParse,
      roundTrip,
      shape: shapeOf(a.content),
      notes,
    };
    rows.push(row);
    if (notes.length > 0) {
      annoEmit("health.fail", `${a.id} ${notes.join("；")}`, {
        level: "warn",
        data: { id: a.id, shape: row.shape, defText: defText || undefined },
      });
    }
  }
  annoEmit("health.run", `体检完成：${rows.length} 条批注`, {
    data: { total: rows.length, failing: rows.filter((r) => r.notes.length > 0).length },
  });
  return rows;
}

/** 控制台便利出口（仅调试用，不参与任何业务逻辑）。 */
export function attachAnnoDebugGlobal(): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    w.__annoDebug = {
      events: annoEvents,
      counters: annoCounters,
      clear: annoDebugClear,
      health: (md: string) => runAnnoHealthCheck(md),
    };
  } catch {
    /* SSR / 无 window 环境静默 */
  }
}
