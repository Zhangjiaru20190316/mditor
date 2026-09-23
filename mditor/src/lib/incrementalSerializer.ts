// S1 顶层块粒度增量序列化（创新算法：序列化输出端的 piece-cache）。
//
// 问题：保存（Ctrl+S/自动保存）、搜索计数、脏标签切换、markdownUpdated 监听
// 都付 O(doc) 的全量序列化——1MB 档实测 662~694ms 主线程长任务（基线
// bench-export-search-save）。
//
// 算法：ProseMirror 节点不可变且结构共享——顶层块未编辑时，新 doc 里的块与
// 旧 doc 是同一对象。以块对象为键（WeakMap）缓存其 markdown 字符串，序列化
// = 变更块重算 + `"\n\n"`.join(全部块串)。复杂度：O(doc) → O(变更块 + 拼接)，
// 摊还后单块编辑的序列化 ≈ 1~3ms（实测见 incrementalSerializer.test.ts 规模
// 曲线；53KB/224KB/1MB 三档）。
//
// 字节等价依据（两层防线）：
//   1. 结构层：doc 节点的 toMarkdown runner 只做 openNode("root")+next
//      （preset-commonmark docSchema），root 无额外 props；顶层块 runner 成对
//      开闭（markdown 块级语法不可跨块携带 mark），单块独立构建的 mdast 与
//      整篇一次构建逐节点等价。
//   2. join 层：mdast-util-to-markdown 的 root join 默认规则里唯一的非
//      「\n\n」情况（缩进 code 紧贴 list，join=false）要求
//      `state.options.fences === false`，而 milkdown 的 remark 实例固定用
//      remarkStringify 默认项（fences='`'，见 core/internal-plugin/init），该
//      分支恒不触发 ⇒ root 各 child 间一律 "\n\n"。安装时校验
//      remarkStringifyOptionsCtx 未设 fences:false（设了就不安装）。
//   3. 兜底：≥1000 步随机编辑差分测试（incrementalSerializer.test.ts，含
//      list+无语言 code 相邻形态）逐字节锚定；任何上游升级改变 join 语义都
//      会先在这里红。
//
// 降级：包装器内部任何异常回退原 serializer；运行时开关
// setIncrementalSerializeEnabled(false) 直接透传（诊断用）。

import {
  remarkCtx as remarkCtxKey,
  remarkStringifyOptionsCtx,
  schemaCtx,
  serializerCtx,
} from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import { SerializerState } from "@milkdown/transformer";
import type { MarkdownNode } from "@milkdown/transformer";
import type { Node as PMNode } from "@milkdown/prose/model";

type NaiveSerializer = (content: unknown) => string;

/** 运行时开关（默认开；诊断/回退用，测试覆盖）。 */
let enabled = true;

export function setIncrementalSerializeEnabled(v: boolean): void {
  enabled = v;
}

export function incrementalSerializeEnabled(): boolean {
  return enabled;
}

/** 预热只对够大的文档有意义（小块文档冷路径本来就快）。 */
const WARM_MIN_BLOCKS = 300;

/** 预热代际令牌：新一次预热（新文档/新实例）取代旧循环。 */
let warmGen = 0;

/**
 * 空闲分片预热块缓存：加载大文档后调用。冷路径 ≈ 朴素全量（每块都要建
 * mdast），首次 Ctrl+S/搜索计数会付整档成本；预热把「首次」挪进 idle 窗口。
 * 分片必须按序列化单元（连续列表 run）整体切——run 被截断会让弹符号状态
 * 在片内缺失，缓存进错误产物。每片一次 idle 回调；条目按键（块对象）恒正确
 * ——文档被编辑后继续预热旧 doc 只是浪费一点空闲 CPU（编辑产生的新块由
 * 首次真实序列化按需补齐），新一次预热用代际令牌取代旧循环。
 */
export function warmIncrementalSerializer(ctx: Ctx, doc: PMNode): void {
  try {
    if (!enabled || doc.childCount < WARM_MIN_BLOCKS) return;
    const schema = ctx.get(schemaCtx);
    const blocks: PMNode[] = [];
    doc.forEach((b) => blocks.push(b));
    const units = serializeUnits(blocks);
    const gen = ++warmGen;
    let i = 0;
    const step = () => {
      if (gen !== warmGen) return; // 新一次预热/新文档取代
      const t0 = performance.now();
      while (i < units.length) {
        const unit = units[i++];
        try {
          const sub = schema.topNodeType.createAndFill(null, unit as never);
          if (sub) (ctx.get(serializerCtx) as NaiveSerializer)(sub);
        } catch {
          /* 预热尽力而为：失败留给真实路径 */
        }
        if (performance.now() - t0 > 8 && i < units.length) break; // 8ms 预算让出
      }
      if (i < units.length) scheduleIdle(step);
    };
    scheduleIdle(step);
  } catch {
    /* 预热失败静默 */
  }
}

const scheduleIdle = (fn: () => void): void => {
  try {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 500 });
      return;
    }
  } catch {
    /* 环境异常退回定时器 */
  }
  window.setTimeout(fn, 16);
};

/** 块串缓存条目：单元 = 单个非列表块，或一段连续列表块（见头注 run 说明）。 */
interface UnitEntry {
  blocks: readonly PMNode[];
  s: string;
}

/**
 * 块字符串缓存：键 = 序列化单元的**末块**对象（PM 不可变+结构共享 ⇒ 未编辑
 * 块恒同键）。连续列表块按 run 合并为一个单元：mdast-util-to-markdown 的
 * `state.bulletLastUsed` 会让相邻列表自动换弹符号（'*'/'-'），逐块独立序列化
 * 会丢失该跨块状态——run 整体序列化则状态在单元内自然传递（差分测试第 198
 * 步曾逮到 '* 再一个列表' vs '- 再一个列表'）。非列表兄弟会重置该状态
 * （containerFlow 对非 list child 清 bulletLastUsed），单元边界因此安全。
 */
const blockCache = new WeakMap<PMNode, UnitEntry>();

const LIST_TYPES = new Set(["bullet_list", "ordered_list"]);

/** 块序列化单元切分（纯函数，可单测）：非列表块自成单元；连续列表块成 run。 */
export function serializeUnits(blocks: readonly PMNode[]): PMNode[][] {
  const units: PMNode[][] = [];
  let run: PMNode[] = [];
  let inRun = false;
  for (const b of blocks) {
    if (LIST_TYPES.has(b.type.name)) {
      run.push(b);
      inRun = true;
    } else {
      if (inRun) units.push(run);
      run = [];
      inRun = false;
      units.push([b]);
    }
  }
  if (inRun) units.push(run);
  return units;
}

/**
 * 用增量实现替换当前编辑器实例的 serializerCtx。
 * 每次编辑器（重）建后调用一次（与 parsePipeline.bindEditor 同位点）；缓存
 * 键是块对象本身，跨调用存活，旧实例的块对象随 doc/历史栈回收而失效。
 * 幂等：检测到已是包装器则跳过。fences:false 的 stringify 配置下不安装。
 */
export function installIncrementalSerializer(ctx: Ctx): void {
  try {
    const naive = ctx.get(serializerCtx) as NaiveSerializer;
    if (!naive || (naive as unknown as { __mditorIncr?: boolean }).__mditorIncr) {
      return; // 未就绪或已安装
    }
    // join 等价防线（见头注）：fences:false 会启用缩进 code 的特殊 join。
    const stringifyOptions = ctx.get(remarkStringifyOptionsCtx) as { fences?: unknown };
    if (stringifyOptions?.fences === false) return;
    const schema = ctx.get(schemaCtx);
    const remark = ctx.get(remarkCtxKey) as unknown as {
      stringify: (tree: unknown) => string;
    };

    const wrapped = ((content: unknown) => {
      if (!enabled) return naive(content);
      try {
        const doc = content as PMNode & { forEach: (f: (n: PMNode) => void) => void };
        if (!doc || typeof doc.forEach !== "function" || doc.childCount < 1) {
          return naive(content);
        }
        const blocks: PMNode[] = [];
        doc.forEach((child) => blocks.push(child));
        const parts: string[] = [];
        for (const unit of serializeUnits(blocks)) {
          const last = unit[unit.length - 1];
          let entry = blockCache.get(last);
          if (
            !entry ||
            entry.blocks.length !== unit.length ||
            entry.blocks.some((b, i) => b !== unit[i])
          ) {
            // 单元（重）算：把 run/单块包成独立顶层 doc 走真 serializer 语义。
            const children: MarkdownNode[] = [];
            for (const b of unit) {
              const sub = schema.topNodeType.createAndFill(null, b);
              if (!sub) throw new Error("createAndFill failed for block");
              const state = new SerializerState(schema);
              state.run(sub);
              const rootMd = state.build() as { children?: MarkdownNode[] } | null;
              for (const m of rootMd?.children ?? []) children.push(m);
            }
            // remark-stringify 的编译器会在文档末尾统一补一个换行——剥掉它，
            // 块间分隔统一由拼接层补 "\n\n"，文档末尾最后补回一次。
            const raw = remark.stringify({ type: "root", children });
            entry = {
              blocks: unit,
              s: raw.endsWith("\n") ? raw.slice(0, -1) : raw,
            };
            blockCache.set(last, entry);
          }
          parts.push(entry.s);
        }
        return parts.join("\n\n") + "\n";
      } catch {
        // 自动降级：任何形态不认识/失败都回到朴素路径（行为等价，性能回旧档）
        return naive(content);
      }
    }) as NaiveSerializer & { __mditorIncr?: boolean };
    wrapped.__mditorIncr = true;
    ctx.set(serializerCtx, wrapped as never);
  } catch {
    /* 安装失败：保持朴素 serializer，行为不变 */
  }
}
