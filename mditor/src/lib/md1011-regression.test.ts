// @vitest-environment jsdom
// MD-1011 回归（真实栈）：整篇文档应用走盖章路径（applyParsedDoc /
// replaceAllStampedDoc）后，同内容重载不得批量替换顶层块（旧路径复现为
// -2H-1/+2H+1，H=标题数；见 docs/overhaul/2026-09-01-md1011.md）。
import { beforeAll, describe, expect, it } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { parserCtx } from "@milkdown/core";
import { $prose } from "@milkdown/utils";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorState } from "@milkdown/prose/state";
import type { Node as PMNode } from "@milkdown/prose/model";
import {
  applyParsedDoc,
  bindEditor,
  replaceAllStampedDoc,
  unbindEditor,
} from "./parsePipeline";

let host: HTMLElement;
let removed = 0;
let added = 0;
const samples: string[] = [];

function resetCounters(): void {
  removed = 0;
  added = 0;
  samples.length = 0;
}

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).requestIdleCallback = ((
    fn: () => void,
  ) => setTimeout(fn, 0)) as unknown as typeof requestIdleCallback;
  host = document.createElement("div");
  host.id = "host";
  document.body.appendChild(host);
});

function attachObserver(): void {
  const pm = host.querySelector(".ProseMirror") as HTMLElement;
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type !== "childList") continue;
      for (const n of r.removedNodes) {
        removed++;
        samples.push(`-${(n as Element).tagName ?? "?"}`);
      }
      for (const n of r.addedNodes) {
        added++;
        samples.push(`+${(n as Element).tagName ?? "?"}`);
      }
    }
  });
  obs.observe(pm, { childList: true });
}

const settle = () => new Promise<void>((r) => setTimeout(r, 20));

// 仿真实文档：H4 + 段落 + 列表交替，每 5 节一张表格（线上触发文档同构）。
// 表格让 F1-F5 的同内容路径也覆盖到自定义节点视图；表格视图的反转语义
// 回归由下方 F6 专门守卫（装饰变化才会走到 spec.update，见 F6 注释）。
function buildMd(nSections: number): string {
  const out: string[] = [];
  for (let i = 0; i < nSections; i++) {
    out.push(`#### 小节 ${i}`);
    out.push("");
    out.push(`这是第 ${i} 节的正文段落，中心句拆三层观点句训练内容。`);
    out.push("");
    out.push(`- 要点甲 ${i}`);
    out.push(`- 要点乙 ${i}`);
    out.push("");
    if (i % 5 === 0) {
      out.push(`| 列甲 ${i} | 列乙 ${i} |`);
      out.push(`| --- | --- |`);
      out.push(`| 行一 ${i} | 行二 ${i} |`);
      out.push("");
    }
  }
  return out.join("\n");
}

describe("MD-1011 回归（Crepe + jsdom，盖章整篇应用）", () => {
  it(
    "同内容整篇重载零顶层替换；增长重载只动增量区间",
    async () => {
      const crepe = new Crepe({
        root: host,
        defaultValue: "",
        features: {
          [Crepe.Feature.CodeMirror]: false,
          [Crepe.Feature.Latex]: false,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.AI]: false,
          [Crepe.Feature.Toolbar]: false,
        },
      });
      await crepe.create();
      bindEditor(crepe.editor.ctx);
      attachObserver();

      const md1 = buildMd(30);
      // 首次载入（盖章 flush）。
      resetCounters();
      crepe.editor.action((ctx) => {
        applyParsedDoc(ctx, ctx.get(parserCtx)(md1)!);
      });
      await settle();
      expect(added).toBeGreaterThan(80); // 空文档 → 全文装入
      resetCounters();

      // F1：同内容 flush 重载（watcher 回声 / 标签切回 / sv 切换同构）。
      // 允许至多 1 对 P 交换（Crepe trailing 插件的文末空段重挂，1<3 不触发
      // classifyPmBatch），但不得出现任何标题批量替换（旧路径 -2H-1）。
      crepe.editor.action((ctx) => {
        applyParsedDoc(ctx, ctx.get(parserCtx)(md1)!);
      });
      await settle();
      expect(removed, samples.join(",")).toBeLessThanOrEqual(1);
      expect(added).toBeLessThanOrEqual(1);
      expect(samples.join(",")).not.toContain("H4");

      // F2：同内容事务式整篇重写（程序化 setValue / 批注回退）。
      resetCounters();
      crepe.editor.action((ctx) => {
        expect(replaceAllStampedDoc(ctx, md1)).toBe(true);
      });
      await settle();
      expect(removed, samples.join(",")).toBeLessThanOrEqual(1);
      expect(samples.join(",")).not.toContain("H4");

      // F3：序列化回读（磁盘=内存的整篇重载）。
      const md2 = crepe.getMarkdown();
      resetCounters();
      crepe.editor.action((ctx) => {
        applyParsedDoc(ctx, ctx.get(parserCtx)(md2)!);
      });
      await settle();
      expect(removed, samples.join(",")).toBeLessThanOrEqual(1);
      expect(samples.join(",")).not.toContain("H4");

      // F4：内容增长后的整篇重载（AI 整篇写回 / 外部同步）：只允许增量
      // 区间的新块落地，存量标题不得整批替换（旧路径此处 -2H-1）。
      const md3 = md2 + buildMd(5);
      resetCounters();
      crepe.editor.action((ctx) => {
        applyParsedDoc(ctx, ctx.get(parserCtx)(md3)!);
      });
      await settle();
      // 5 个新区间（H4/P/UL ×5；H4 双计也 ≤10+尾块），远小于 2×35+1 的整批替换。
      expect(removed, samples.join(",")).toBeLessThanOrEqual(6);
      expect(added).toBeLessThanOrEqual(20);

      // F5：盖章幂等——对已盖章内容重载，只余尾段交换。
      resetCounters();
      crepe.editor.action((ctx) => {
        applyParsedDoc(ctx, ctx.get(parserCtx)(md3)!);
      });
      await settle();
      expect(removed, samples.join(",")).toBeLessThanOrEqual(1);
      expect(samples.join(",")).not.toContain("H4");

      // 收尾：view 必须仍活着（盖章路径未破坏状态机）。
      const v = crepe.editor.ctx.get(editorViewCtx);
      expect(v.state.doc.childCount).toBeGreaterThan(90);
      unbindEditor();
    },
    60000,
  );

  // MD-1011 残余（4.10.0-beta.2 根修）：@milkdown/components 的
  // TableNodeView.update() 在新旧节点相同时错误返回 false（ProseMirror 契约
  // = 销毁重建）。触发条件是「内容相同 + 装饰变化」：内容相同时 matchesNode
  // 本可命中（零成本复用），但装饰（cvMemory 学习尺寸 / 预热区间的
  // content-visibility）一变，sameOuterDeco 失败 → 落入 updateNextNode 位置
  // 回退 → spec.update → 上游对相同内容返回 false → recreateWrapper 把子 DOM
  // 移植进新壳、旧壳留空（线上 -197/+197 批次、空壳指纹
  // <div.milkdown-table-block ×0> 的来源；~20 波 = 预热分批逐步扩大区间）。
  // 本用例用装饰开关复现该路径：A/B 实证补丁缺失时两张表以
  // -DIV,-DIV,+DIV,+DIV 重建（与生产指纹一致），补丁在位时视图原位保留、
  // 装饰 style 补在同一个包装器上。
  it(
    "装饰变化 + 同内容重载不重建表格视图（TableNodeView.update 语义回归）",
    async () => {
      let decoOn = false;
      const probeKey = new PluginKey<DecorationSet>("probe-table-deco");
      // 与 cvMemory 的 buildDecos 同构的「有选择」版本：只给表格块盖
      // Decoration.node style 装饰（模拟有学习尺寸/预热区间的块），开关翻转
      // 等价于预热批次给区间块追加/收走 content-visibility: visible。
      const makeDeco = (doc: PMNode): DecorationSet => {
        if (!decoOn) return DecorationSet.empty;
        const decos: Decoration[] = [];
        doc.forEach((node, offset) => {
          if (node.type.name !== "table") return;
          decos.push(
            Decoration.node(offset, offset + node.nodeSize, {
              style: "contain-intrinsic-size: 10px 20px; --probe-cv: 1",
            })
          );
        });
        return DecorationSet.create(doc, decos);
      };
      const probeDeco = $prose(
        () =>
          new Plugin<DecorationSet>({
            key: probeKey,
            state: {
              // init 也要接开关：applyParsedDoc 的 flush 语义是 EditorState
              // 整体重建，插件 state 走 init 而非 apply。
              init: (_cfg, state) => makeDeco(state.doc),
              apply: (tr) => makeDeco(tr.doc),
            },
            props: {
              decorations: (state: EditorState) => probeKey.getState(state),
            },
          })
      );

      // 独立 root：本文件首个用例的 .ProseMirror 仍挂在 host 里。
      const host2 = document.createElement("div");
      document.body.appendChild(host2);
      const crepe = new Crepe({
        root: host2,
        defaultValue: "",
        features: {
          [Crepe.Feature.CodeMirror]: false,
          [Crepe.Feature.Latex]: false,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.AI]: false,
          [Crepe.Feature.Toolbar]: false,
        },
      });
      crepe.editor.use(probeDeco);
      await crepe.create();
      bindEditor(crepe.editor.ctx);

      const md = buildMd(6); // 含两张表（i=0、i=5）
      crepe.editor.action((ctx) => {
        applyParsedDoc(ctx, ctx.get(parserCtx)(md)!);
      });
      await settle();
      const pm = host2.querySelector(".ProseMirror") as HTMLElement;
      expect(pm.querySelectorAll(".milkdown-table-block").length).toBe(2);

      // 观察本用例自己的 PM 根。
      let removed2 = 0;
      let added2 = 0;
      const samples2: string[] = [];
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type !== "childList") continue;
          for (const n of r.removedNodes) {
            removed2++;
            samples2.push(`-${(n as Element).tagName ?? "?"}`);
          }
          for (const n of r.addedNodes) {
            added2++;
            samples2.push(`+${(n as Element).tagName ?? "?"}`);
          }
        }
      });
      obs.observe(pm, { childList: true });

      // 同内容 + 装饰翻转（复现切换回文档时装饰重算的视图更新路径）。
      decoOn = true;
      crepe.editor.action((ctx) => {
        applyParsedDoc(ctx, ctx.get(parserCtx)(md)!);
      });
      await settle();
      obs.disconnect();

      // 表格视图必须原位保留：允许至多 1 对尾段交换（与 F1 同口径），但
      // 不得出现任何 DIV 重建（补丁缺失时为 -DIV/-DIV/+DIV/+DIV）。
      expect(samples2.join(",")).not.toContain("DIV");
      expect(removed2).toBeLessThanOrEqual(1);
      expect(added2).toBeLessThanOrEqual(1);
      // 装饰确实生效（否则上面的零替换只是没走到该路径）。
      expect(pm.querySelectorAll(".milkdown-table-block").length).toBe(2);
      const wrappers = Array.from(pm.querySelectorAll(".milkdown-table-block"));
      console.log(
        "WRAP STYLES:",
        wrappers.map((w) => (w as HTMLElement).getAttribute("style")).join(" || ")
      );
      expect(
        wrappers.some((w) =>
          ((w as HTMLElement).getAttribute("style") ?? "").includes("--probe-cv: 1")
        ) ||
          pm.querySelector('[style*="probe-cv"]') != null,
        "装饰 style 应落在表格包装器上"
      ).toBe(true);

      unbindEditor();
    },
    60000,
  );
});
