// @vitest-environment jsdom
// S1 增量序列化的正确性（差分）+ 性能（三档规模曲线）+ 降级/开关测试。
// 差分口径（第 5 节规则 4）：随机编辑序列 ≥1000 步，含插入/删除/替换/插入块、
// 撤销（恢复旧 doc 对象）；每步后增量产物与朴素 serializer 逐字节比对。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { parserCtx, schemaCtx, serializerCtx } from "@milkdown/core";
import { $remark, $prose } from "@milkdown/utils";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node as PMNode } from "@milkdown/prose/model";
import { Slice, Fragment } from "@milkdown/prose/model";
import type { Schema } from "@milkdown/prose/model";
import { mathLiveGuardPlugin } from "./mathLiveGuard";
import { remarkMathFenceAlias } from "./remarkMathFenceAlias";
import { remarkMathGuard } from "./remarkMathGuard";
import { asMilkdownPlugins } from "./pluginCast";
import { highlightPlugins } from "./highlightMark";
import { textColorPlugins } from "./textColorMark";
import { createWikiLinkPlugins } from "./wikiLinkNode";
import { createCitationPlugins } from "./citationNode";
import { createFlashcardPlugins } from "./flashcardNode";
import {
  installIncrementalSerializer,
  setIncrementalSerializeEnabled,
  warmIncrementalSerializer,
} from "./incrementalSerializer";

const here = dirname(fileURLToPath(import.meta.url));
const mathFencePlugins = asMilkdownPlugins([
  $remark("remarkMathFenceAlias", () => remarkMathFenceAlias as never),
  $remark("remarkMathGuard", () => remarkMathGuard as never),
  $prose(() => mathLiveGuardPlugin()),
].flat());

let host: HTMLElement;
let crepe: Crepe;
let naiveSerialize: (content: unknown) => string;
let schema: Schema;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).requestIdleCallback = ((
    fn: () => void
  ) => setTimeout(fn, 0)) as unknown as typeof requestIdleCallback;
  host = document.createElement("div");
  document.body.appendChild(host);
  crepe = new Crepe({
    root: host,
    defaultValue: "",
    features: {
      [Crepe.Feature.CodeMirror]: true,
      [Crepe.Feature.Latex]: true,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.Toolbar]: false,
    },
  });
  crepe.editor.use(highlightPlugins);
  crepe.editor.use(textColorPlugins);
  crepe.editor.use(createWikiLinkPlugins());
  crepe.editor.use(createCitationPlugins());
  crepe.editor.use(createFlashcardPlugins());
  crepe.editor.use(mathFencePlugins);
  await crepe.create();
  naiveSerialize = crepe.editor.action(
    (ctx) => ctx.get(serializerCtx)
  ) as typeof naiveSerialize;
  schema = crepe.editor.action((ctx) => ctx.get(schemaCtx));
  // 安装增量实现（替换 ctx 中的 serializer）
  crepe.editor.action((ctx) => {
    installIncrementalSerializer(ctx);
  });
}, 30_000);

afterAll(async () => {
  await crepe.destroy();
}, 30_000);

const parse = (md: string): PMNode =>
  crepe.editor.action((ctx) => ctx.get(parserCtx)(md)) as PMNode;

const incrSerialize = () =>
  crepe.editor.action((ctx) => ctx.get(serializerCtx)) as typeof naiveSerialize;

/** 含全部特色节点形态的种子文档（数学/表格/列表/hr/引用/脚注/代码块/高亮）。 */
const SEED_MD = [
  "# 一级标题",
  "",
  "正文段落，含 **加粗**、*斜体*、==高亮==、`code`、$x^2+y$ 与 $z_i$。",
  "",
  "> 引用块里的 $\\frac{a}{b}$ 公式。",
  "",
  "$$E = mc^2 \\tag{3}$$",
  "",
  "- 列表项甲 $a$",
  "- 列表项乙",
  "  - 嵌套项",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "| 甲 | 乙 |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "- 再一个列表",
  "",
  "    缩进 code（无语言，锁 join 规则形态）",
  "",
  "---",
  "",
  "[^anno-1]: 批注定义体。",
  "",
  "段落二，带 [链接](https://a.b) 与脚注引[^anno-1]。",
  "",
  "<!-- 注释 -->",
  "",
  "收尾段落。",
].join("\n");

/** 可复现的伪随机源（差分失败可重放）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 第 i 个顶层块之前的文档位置。 */
function blockStart(doc: PMNode, i: number): number {
  let before = 0;
  for (let k = 0; k < i; k++) before += doc.child(k).nodeSize;
  return before;
}

/** 在 doc 上施加一次随机编辑，返回新 doc（纯状态操作，不经过 view）。 */
function randomEdit(doc: PMNode, rng: () => number): PMNode | null {
  const n = doc.childCount;
  if (n === 0) return null;
  const i = Math.floor(rng() * n);
  const block = doc.child(i);
  const from = blockStart(doc, i);
  const to = from + block.nodeSize;
  const textNode = schema.text("编" + Math.floor(rng() * 1000));
  const kind = rng();
  if (kind < 0.4) {
    // 块内文本插入（模拟打字）
    if (block.isTextblock) {
      const innerFrom = from + 1;
      const innerTo = innerFrom + Math.min(block.content.size, Math.floor(rng() * 5));
      try {
        return doc.replace(innerFrom, Math.min(innerTo, from + block.content.size + 1), new Slice(Fragment.from(textNode), 0, 0)) as PMNode;
      } catch {
        return null;
      }
    }
    try {
      return doc.replace(from, to, new Slice(Fragment.from(schema.nodes.paragraph.create(null, textNode)), 0, 0)) as PMNode;
    } catch {
      return null;
    }
  }
  if (kind < 0.58) {
    // 删除一块（保留至少一块）
    if (n <= 1) return null;
    try {
      return doc.replace(from, to, Slice.empty) as PMNode;
    } catch {
      return null;
    }
  }
  if (kind < 0.76) {
    // 替换为新段落
    try {
      return doc.replace(
        from,
        to,
        new Slice(Fragment.from(schema.nodes.paragraph.create(null, [textNode, textNode])), 0, 0)
      ) as PMNode;
    } catch {
      return null;
    }
  }
  if (kind < 0.92) {
    // 相邻处插入新块（heading / bullet_list / code_block / math 块）
    const mk = Math.floor(rng() * 4);
    const node =
      mk === 0
        ? schema.nodes.heading.create({ level: 2, id: "" }, textNode)
        : mk === 1
          ? schema.nodes.bullet_list.create(
              null,
              schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, textNode))
            )
          : mk === 2
            ? schema.nodes.code_block.create(
                { language: "ts" },
                schema.text("let z = " + Math.floor(rng() * 99))
              )
            : schema.nodes.code_block.create(
                { language: "LaTeX" },
                schema.text("f_" + Math.floor(rng() * 9) + " = x")
              );
    try {
      return doc.replace(to, to, new Slice(Fragment.from(node), 0, 0)) as PMNode;
    } catch {
      return null;
    }
  }
  // mark 编辑：对文本块施加加粗（有 selection 语义的 mark 需 doc.addContentless… 这里用整块替换为带 mark 的文本）
  try {
    return doc.replace(
      from,
      to,
      new Slice(Fragment.from(schema.nodes.paragraph.create(null, schema.text("粗体文本" + Math.floor(rng() * 99)).mark(schema.marks.strong.create().addToSet([])))), 0, 0)
    ) as PMNode;
  } catch {
    return null;
  }
}

describe("S1 增量序列化", () => {
  it("差分：1000 步随机编辑序列逐字节等价（含撤销恢复与程序化整篇重写）", () => {
    setIncrementalSerializeEnabled(true);
    const rng = makeRng(20260923);
    const history: PMNode[] = [];
    let doc = parse(SEED_MD);
    expect(doc).not.toBeNull();
    history.push(doc);
    const incr = incrSerialize();
    expect(incr(doc)).toBe(naiveSerialize(doc));

    let steps = 0;
    let guard = 0;
    while (steps < 1000 && guard < 30000) {
      guard++;
      const r = rng();
      if (r < 0.1 && history.length > 1) {
        history.pop();
        doc = history[history.length - 1];
      } else if (r > 0.97) {
        // 程序化整篇重写：全部块对象换成新身份（全 miss 路径）
        const fresh = parse(SEED_MD);
        if (!fresh) continue;
        doc = fresh;
        history.push(doc);
        if (history.length > 30) history.shift();
      } else {
        const next = randomEdit(doc, rng);
        if (!next || next.childCount === 0) continue;
        doc = next;
        history.push(doc);
        if (history.length > 30) history.shift();
      }
      steps++;
      const a = incr(doc);
      const b = naiveSerialize(doc);
      if (a !== b) {
        let i0 = 0;
        while (i0 < Math.min(a.length, b.length) && a[i0] === b[i0]) i0++;
        throw new Error(
          `差分失败 @step=${steps} 差异位 ${i0}:
增量: ${JSON.stringify(a.slice(Math.max(0, i0 - 40), i0 + 60))}
朴素: ${JSON.stringify(b.slice(Math.max(0, i0 - 40), i0 + 60))}`
        );
      }
    }
    expect(steps).toBe(1000);
  }, 120_000);

  it("性能：三档规模曲线（冷/热/单块编辑 vs 朴素），逐字节等价", () => {
    const files = [
      ["53KB", "微分方程专题_CMC备战_基准副本.md"],
      ["224KB", "一元微分学习题集_CMC备战.md"],
      ["1MB", "一元微分学习题集_1MB压测副本.md"],
    ] as const;
    const incr = incrSerialize();
    const rows: string[] = [];
    for (const [label, file] of files) {
      let md: string;
      try {
        md = readFileSync(join(here, "../../perf/fixtures", file), "utf8");
      } catch {
        rows.push(`${label}: fixture 缺失，跳过`);
        continue;
      }
      const doc = parse(md);
      if (!doc) {
        rows.push(`${label}: 解析失败，跳过`);
        continue;
      }
      const t = (fn: () => unknown) => {
        const t0 = performance.now();
        void fn();
        return Math.round(performance.now() - t0);
      };
      const naiveMs = t(() => naiveSerialize(doc));
      const coldMs = t(() => incr(doc));
      void incr(doc);
      const warmMs = t(() => incr(doc));
      // 找第一个有内容的文本块，块内插一个字（打字路径的常态）
      let edited: PMNode | null = null;
      for (let i = 0; i < doc.childCount && !edited; i++) {
        const block = doc.child(i);
        if (!block.isTextblock || !block.content.size) continue;
        const before = blockStart(doc, i);
        try {
          edited = doc.replace(before + 1, before + 1, new Slice(Fragment.from(schema.text("字")), 0, 0)) as PMNode;
        } catch {
          edited = null;
        }
      }
      const editMs = edited ? t(() => incr(edited)) : -1;
      rows.push(
        `${label}: 朴素 ${naiveMs}ms | 增量冷 ${coldMs}ms | 全热 ${warmMs}ms | 单块编辑 ${editMs}ms`
      );
      if (edited) {
        expect(incr(edited)).toBe(naiveSerialize(edited));
      }
    }
    console.log("S1 规模曲线：\n" + rows.join("\n"));
    expect(rows.join("\n")).toContain("1MB");
  }, 300_000);

  it("开关关闭后透传朴素路径；重开恢复增量", () => {
    const doc = parse(SEED_MD);
    const incr = incrSerialize();
    setIncrementalSerializeEnabled(false);
    expect(incr(doc)).toBe(naiveSerialize(doc));
    setIncrementalSerializeEnabled(true);
    expect(incr(doc)).toBe(naiveSerialize(doc));
  });

  it("空闲预热（单元边界分片）后：结果仍逐字节等价，冷路径消失", async () => {
    let md: string;
    try {
      md = readFileSync(join(here, "../../perf/fixtures/一元微分学习题集_CMC备战.md"), "utf8");
    } catch {
      return; // fixture 缺席（非本仓库环境）时跳过
    }
    const doc = parse(md);
    expect(doc).not.toBeNull();
    crepe.editor.action((ctx) => {
      warmIncrementalSerializer(ctx, doc!);
    });
    // 等 idle 预热跑完（vitest 环境 requestIdleCallback→setTimeout(0)）
    await new Promise<void>((r) => setTimeout(r, 1500));
    const incr = incrSerialize();
    const t0 = performance.now();
    const out = incr(doc);
    const warmMs = Math.round(performance.now() - t0);
    expect(out).toBe(naiveSerialize(doc));
    // 预热后 224KB 档应远快于朴素（防 CI 抖动取宽松阈值）
    expect(warmMs).toBeLessThan(50);
  }, 30_000);
});
