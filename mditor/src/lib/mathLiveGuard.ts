// 行内假公式的实时降级（v4.12.1）——remarkMathGuard 的 ProseMirror 侧镜像。
//
// 背景：输入规则（input rule）绕过 remark，crepe 的 mathInlineInputRule
// （patch 里已收紧首尾空白）在键入价格区间时仍会瞬时生成假公式节点——
// `范围 $1-$10 之间` 敲到第二个 `$` 的瞬间，math_inline("1-") 已经成型，
// 此后继续敲的 `10` 落在节点后面。remarkMathGuard 只在整篇解析（文件载入
// / worker 预解析）时看得到树，实时打字永远轮不到它。
//
// 本插件以 appendTransaction 在产生假公式的同一事务后补一道降级，规则与
// lib/remarkMathGuard.ts 完全一致（cmark-gfm dollar_math）：
//   1. 值首尾是空白（`$ a$` / `$a $`——输入规则已拦，此为 toggleInlineMath
//      等其他创建路径的兜底）；
//   2. 闭 `$` 后紧跟的文本以数字开头（`$1-$10`；对齐 GitHub：`$x_1$2` 也
//      不是公式——下一文本兄弟首字符为数字即降级）。
// 降级 = 把节点替换回字面文本 `$…$`（与 remark 侧降级产物逐字符一致，序列
// 化往返稳定：再解析仍判违规、再降级、同一结果）。
//
// 纯逻辑（mathValueViolatesGuard / findMathGuardViolations）与插件分离，
// vitest 用最小 Schema 直接锚定扫描语义，不需要起编辑器。
//
// 仅小文档注册（与 Latex 特性同开同关——big 档没有 math_inline 节点）；
// $prose 插件不进 remarkPluginsCtx，与 remarkPipeline 的 expectedPluginCount
// 哨兵无关。

import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { Transaction } from "@milkdown/prose/state";
import type { Node as PMNode } from "@milkdown/prose/model";

/** 规则 1：值首尾空白（remarkMathGuard 的 `v !== v.trim()`）。 */
export function mathValueHasLooseEdges(value: string): boolean {
  return value !== value.trim();
}

/** 规则 2：闭 `$` 后紧跟的首个文本兄弟以数字开头。 */
export function nextTextStartsWithDigit(text: string | null | undefined): boolean {
  if (!text) return false;
  const c = text[0];
  return c >= "0" && c <= "9";
}

/** 两条规则的合并判定（降级决策点）。 */
export function mathValueViolatesGuard(
  value: string,
  nextSiblingText: string | null
): boolean {
  return mathValueHasLooseEdges(value) || nextTextStartsWithDigit(nextSiblingText);
}

/** math_inline 节点（起点 nodePos）在父块内容里的下一个文本兄弟的首段文本。
 *  用子节点偏移显式定位（ResolvedPos.index 在边界位置的语义不直观，不赌）。 */
function nextSiblingText(doc: PMNode, nodePos: number): string | null {
  const $pos = doc.resolve(nodePos);
  const parent = $pos.parent;
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (offset >= $pos.parentOffset) {
      // child i 即 math_inline 本身；违规判定看它的下一个兄弟。
      const next = i + 1 < parent.childCount ? parent.child(i + 1) : null;
      return next && next.isText ? next.text ?? null : null;
    }
    offset += child.nodeSize;
  }
  return null;
}

export interface MathGuardVictim {
  /** 节点起始位置（替换区间 [pos, pos + nodeSize)）。 */
  pos: number;
  node: PMNode;
}

/**
 * 在 doc 的给定区间里找出全部违规 math_inline 节点（纯扫描，不改文档）。
 * 与 remarkMathGuard 的判定同源；同一位置去重（区间可能重叠）。
 */
export function findMathGuardViolations(
  doc: PMNode,
  ranges: Array<{ from: number; to: number }>
): MathGuardVictim[] {
  const size = doc.content.size;
  const byPos = new Map<number, MathGuardVictim>();
  for (const r of ranges) {
    const from = Math.max(0, Math.min(r.from, size));
    const to = Math.max(from, Math.min(r.to, size));
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name !== "math_inline") return true;
      if (!byPos.has(pos)) {
        const value = String(node.attrs.value ?? "");
        if (mathValueViolatesGuard(value, nextSiblingText(doc, pos))) {
          byPos.set(pos, { pos, node });
        }
      }
      return true;
    });
  }
  return [...byPos.values()];
}

export const mathLiveGuardKey = new PluginKey("mditor-math-live-guard");

/**
 * 扫描本次事务集合触碰过的文档区间（映射到新 doc 坐标，向两侧外扩 2 以
 * 覆盖紧邻变区边界的公式节点），对违规节点从后往前降级。降级产物是纯文
 * 本，再次进入本插件时零命中——天然终止，无循环风险。
 */
export function mathLiveGuardPlugin(): Plugin {
  return new Plugin({
    key: mathLiveGuardKey,
    appendTransaction: (trs, _oldState, newState) => {
      const ranges: Array<{ from: number; to: number }> = [];
      for (const t of trs) {
        if (!t.docChanged) continue;
        t.steps.forEach((step, i) => {
          step.getMap().forEach((_fromA, _toA, fromB, toB) => {
            let from = fromB;
            let to = toB;
            // 该 step 之后还有映射时，把区间平移到最终 doc 坐标。
            for (let j = i + 1; j < t.mapping.maps.length; j++) {
              const m = t.mapping.maps[j];
              from = m.map(from, -1);
              to = m.map(to, 1);
            }
            ranges.push({ from: from - 2, to: to + 2 });
          });
        });
      }
      if (ranges.length === 0) return null;
      const victims = findMathGuardViolations(newState.doc, ranges);
      if (victims.length === 0) return null;
      const tr: Transaction = newState.tr;
      // 从后往前替换：前面的位置不受后续替换影响。
      victims.sort((a, b) => b.pos - a.pos);
      for (const v of victims) {
        const value = String(v.node.attrs.value ?? "");
        tr.replaceWith(
          v.pos,
          v.pos + v.node.nodeSize,
          v.node.type.schema.text(`$${value}$`)
        );
      }
      return tr;
    },
  });
}
