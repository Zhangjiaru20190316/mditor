// heading id 预盖章（MD-1011「PM 顶层块批量替换」根修）。
//
// 根因（2026-09-01 定罪，证据链见 docs/overhaul/md1011-*.md）：整篇应用文档
// （replaceAll flush 的 EditorState 重建 / tr.replace 全文事务）时，解析产物
// 的 heading id 与在编辑器里已被 sync-heading-id 插件盖章的 id 不一致——
//   * 解析器产出的 heading id 为空/默认；
//   * prosemirror-view 的子节点匹配按 node.eq（含 attrs）判定，id 不同 →
//     该 heading 块整棵 DOM 重建（第 1 次替换）；
//   * 文档落地后 sync-heading-id 插件的 view.update 发现 id 缺失，dispatch
//     setNodeMarkup 盖章 → 同一批 heading 再次整块重建（第 2 次替换）。
// 标题密集文档（数学习题/训练手册，H4 × 50+）一次整篇载入替换 2H+1 个顶层
// 块 —— 线上 MD-1011 计数（79=2×39+1 → 105=2×52+1）与之一一对应。元素消亡
// 还带走 content-visibility 的 remembered size，下游产生 MD-1002/MD-1001。
//
// 根修：整篇应用前，按 sync-heading-id 插件的同一算法（生成器 slice +
// 「-#N」去重后缀，见 preset-commonmark sync-heading-id-plugin）把 id 预先
// 盖进解析产物。内容未变的重载（watcher 回声 / 标签切回 / sv 切换 / 程序化
// 整篇写回）→ id 全同 → node.eq 成立 → 零 DOM 替换；sync 插件随后核对也
// 全部命中，不再 dispatch 盖章事务。内容真变了（换文件 / AI 全文改写）→
// 仅文本实际变化的 heading 被替换（正确且最小）。
//
// 算法纪律：与 milkdown 的 sync-heading-id 逐字对齐（跳过空文本标题、
// descendants 文档序、重复 id 追加 `-#N`），否则预盖的 id 与插件期望不符，
// 会再次触发盖章事务（替换次数减半但不归零）。生成器从 ctx 的
// headingIdGenerator slice 动态读取（应用在创建后覆写为 headingSlugBase，
// 预盖章必须与插件看到的是同一个函数）。

import type { Ctx } from "@milkdown/ctx";
import { headingIdGenerator } from "@milkdown/kit/preset/commonmark";
import { Fragment, type Node as PMNode } from "@milkdown/prose/model";

/** 与 sync-heading-id 相同的 id 计算（生成器 + `-#N` 去重）。导出供单测。 */
export function computeHeadingIds(
  doc: PMNode,
  getId: (node: PMNode) => string
): Map<number, string> {
  const out = new Map<number, string>();
  const idMap: Record<string, number> = {};
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    // 空文本标题跳过（与插件一致：保留现有 attrs，不生成 id）。
    if (node.textContent.trim().length === 0) return;
    let id = getId(node);
    if (idMap[id]) {
      idMap[id] += 1;
      id += `-#${idMap[id]}`;
    } else {
      idMap[id] = 1;
    }
    if (node.attrs.id !== id) out.set(pos, id);
  });
  return out;
}

/** 就地盖章：返回盖好 id 的文档（无变化时原样返回同一引用）。
 *
 * v4.20 性能：盖在**离线解析产物**上（不经视图、无并发事务），原先走
 * Transform.setNodeMarkup 逐步机器——每步 resolveCached/validContent/cut 全
 * 套验证，1MB 文档（1,666 标题）实测 1,047ms（打开窗口剖面：resolve 302 +
 * validContent 271 + cut 170 + findIndex 156……盖章本体仅 5.6ms）。改为单趟
 * 直建：只重建含变更的骨架节点（PM 结构共享，未变子树原引用复用），语义与
 * setNodeMarkup 等价（同 attrs 合并、保 content 与 marks、不做内容校验——
 * type.create 不校验，setNodeMarkup 的 validContent 对纯 attrs 变更必过，
 * 差异仅在防御性，而输入是刚解析出的合法文档）。 */
export function stampHeadingIds(
  doc: PMNode,
  getId: (node: PMNode) => string
): PMNode {
  try {
    const ids = computeHeadingIds(doc, getId);
    if (ids.size === 0) return doc;
    const content = stampFragment(doc.content, 0, ids);
    if (!content) return doc;
    return doc.type.create(doc.attrs, content);
  } catch {
    // 预盖章是优化：任何失败回退未盖章文档（行为同旧版，仅保留两次替换）。
    return doc;
  }
}

/** 单趟重建：basePos 为 frag 首个子节点的文档位置（doc.content 从 0 起，
 *  嵌套块为父 pos+1——与 computeHeadingIds 的 descendants 位置语义一致）。
 *  有变更返回新 Fragment，无变更返回 null（外层保留原引用，零拷贝）。 */
function stampFragment(
  frag: Fragment,
  basePos: number,
  ids: Map<number, string>
): Fragment | null {
  let changed = false;
  const out: PMNode[] = [];
  let pos = basePos;
  for (let i = 0; i < frag.childCount; i++) {
    const child = frag.child(i);
    let repl = child;
    const id = ids.get(pos);
    if (id !== undefined && child.type.name === "heading") {
      repl = child.type.create({ ...child.attrs, id }, child.content, child.marks);
      changed = true;
    } else if (child.isBlock && child.childCount > 0) {
      const inner = stampFragment(child.content, pos + 1, ids);
      if (inner) {
        repl = child.type.create(child.attrs, inner, child.marks);
        changed = true;
      }
    }
    out.push(repl);
    pos += child.nodeSize;
  }
  return changed ? Fragment.fromArray(out) : null;
}

/** 从 Milkdown ctx 读当前生成器并盖章（应用内所有整篇应用路径共用）。 */
export function stampHeadingIdsFromCtx(ctx: Ctx, doc: PMNode): PMNode {
  try {
    const getId = ctx.get(headingIdGenerator.key) as (node: PMNode) => string;
    return stampHeadingIds(doc, getId);
  } catch {
    return doc;
  }
}
