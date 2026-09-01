// @vitest-environment jsdom
// MD-1011 回归（真实栈）：整篇文档应用走盖章路径（applyParsedDoc /
// replaceAllStampedDoc）后，同内容重载不得批量替换顶层块（旧路径复现为
// -2H-1/+2H+1，H=标题数；见 docs/overhaul/2026-09-01-md1011.md）。
import { beforeAll, describe, expect, it } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { parserCtx } from "@milkdown/core";
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

// 仿真实文档：H4 + 段落 + 列表交替（线上触发文档同构）。
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
});
