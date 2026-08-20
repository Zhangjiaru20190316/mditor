// 批注生命周期的定点 ProseMirror 事务（v3.9.1）。
//
// 批注操作全家族（创建追加、流式/编辑替换、收尾、删除）都只触碰
// footnote_definition / footnote_reference 节点，绝不整篇 replace——整篇替换
// 会把文档里所有代码块的 CodeMirror 子编辑器（CodeMirrorBlock node view）
// 连根销毁重建（先渲染纯 <pre> 占位再初始化 CM），肉眼即「代码块闪烁」
// （v3.9 修复报告确认的根因）。调用方（useMilkdown facade）在这些操作返回
// false 时回退旧整篇路径，保证语义与健壮性不回退。

import { editorViewCtx, parserCtx } from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import { closeHistory } from "@milkdown/prose/history";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { buildDefinition } from "./annotations";
import type { CodeLineMeta } from "./codeAnno";

interface Region {
  pos: number;
  size: number;
}

/** 定点操作的结果与失败原因。Editor 层据此决定「跳过流式帧」还是「整篇
 *  回退」：rich 模式下整篇 setValue 每帧一次会把所有代码块的 CodeMirror
 *  子编辑器连根重建（徽章编号丢失 + 代码块闪烁），只允许作为最后手段。
 *  - no-def：文档里找不到该批注的定义节点（孤儿 / 被解析丢弃）；
 *  - no-parse：定义体（流式中间态）解析不出 footnote_definition 节点；
 *  - surface：当前编辑表面不支持定点操作（sv 模式 / 实例未就绪）——
 *    该表面整篇写回代价低，照旧回退即可。 */
export type TargetedOpResult =
  | { ok: true }
  | { ok: false; reason: "no-def" | "no-parse" | "surface" };

/** 一条批注在文档里的全部落点（引用 + 定义），按删除/重建需要整理好。 */
interface AnnotationSpans {
  /** 定义节点区间；找不到 → null。 */
  defRegion: Region | null;
  /** 待删除区间（引用 / 整段删除的 marker 段 / 定义），未排序、未去重。 */
  deletes: { from: number; to: number }[];
  /** 重建落点（供 finalize 第②步按原位放回）：marker-only 段重建整段，
   *  行内引用只重建内联 marker。坐标基于收集时的文档。 */
  inserts: { pos: number; asParagraph: boolean }[];
}

/** 在当前文档里定位指定批注的 footnote_definition 节点区间（找不到 → null）。 */
function findDefinitionRegion(view: EditorView, id: string): Region | null {
  let region: Region | null = null;
  view.state.doc.descendants((node, pos) => {
    if (region) return false;
    if (
      node.type.name === "footnote_definition" &&
      node.attrs.label === id
    ) {
      region = { pos, size: node.nodeSize };
      return false;
    }
    return true;
  });
  return region;
}

/** 收集一条批注的全部落点：定义区间 + 每个引用（及其所在段落是否整段
 *  属于该批注——段落子节点全部是该 id 的引用时，删除/重建都以段为单位，
 *  与 insertAnnoMarker 代码块分支创建的 marker 段落形态一致）。 */
function collectAnnotationSpans(doc: PMNode, id: string): AnnotationSpans {
  const spans: AnnotationSpans = { defRegion: null, deletes: [], inserts: [] };
  // 按段落聚合引用，才能判断「段落是否只剩该批注的引用」。
  const paras = new Map<
    number,
    { end: number; childCount: number; refs: { from: number; to: number }[] }
  >();
  doc.descendants((node, pos) => {
    if (node.type.name === "footnote_definition" && node.attrs.label === id) {
      spans.defRegion = { pos, size: node.nodeSize };
      return true;
    }
    if (node.type.name === "footnote_reference" && node.attrs.label === id) {
      const $from = doc.resolve(pos);
      const para = $from.parent;
      const start = $from.before($from.depth);
      const entry = paras.get(start) ?? {
        end: start + para.nodeSize,
        childCount: para.childCount,
        refs: [],
      };
      entry.refs.push({ from: pos, to: pos + node.nodeSize });
      paras.set(start, entry);
      return false;
    }
    return true;
  });
  for (const [start, entry] of paras) {
    const onlyOurs = entry.childCount === entry.refs.length;
    if (onlyOurs) {
      // 整段都是该批注的 marker（代码块下方的 marker 段落形态）：
      // 删整段、重建整段（一个段落一个 marker，重复引用自然去重）。
      spans.deletes.push({ from: start, to: entry.end });
      spans.inserts.push({ pos: start, asParagraph: true });
    } else {
      for (const r of entry.refs) {
        spans.deletes.push(r);
        spans.inserts.push({ pos: r.from, asParagraph: false });
      }
    }
  }
  if (spans.defRegion) {
    spans.deletes.push({
      from: spans.defRegion.pos,
      to: spans.defRegion.pos + spans.defRegion.size,
    });
  }
  return spans;
}

/** 把一段定义源码解析出对应的 footnote_definition 节点（找不到/解析失败 → null）。 */
function parseDefinitionNode(ctx: Ctx, src: string, id: string): PMNode | null {
  const parsed = ctx.get(parserCtx)(src);
  let node: PMNode | null = null;
  parsed?.descendants((n) => {
    if (node) return false;
    if (
      n.type.name === "footnote_definition" &&
      n.attrs.label === id
    ) {
      node = n;
      return false;
    }
    return true;
  });
  return node;
}

/** 区间去重后按位置倒序排列（倒序删除/插入时前面的坐标始终有效）。 */
function dedupeDescending(ranges: { from: number; to: number }[]) {
  const seen = new Set<string>();
  const out: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const key = `${r.from}-${r.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => b.from - a.from);
}

/** 定义插入落点：文末，但跳过 trailing 空段落（插在它们前面）。crepe 的
 *  trailing 插件在文档末尾常驻一个空段落；往 content.size（空段之后）插
 *  定义会把旧空段滞留在定义之前，序列化为顶级 `<br />`——每次批注收尾
 *  丢弃/重挂定义都会再滞留一条，长期使用后文末积累一串 <br/>（用户真实
 *  文档中已观测到此污染，v3.9.3 harness 复现并修复）。 */
function defInsertPos(doc: PMNode): number {
  let pos = doc.content.size;
  for (let i = doc.childCount - 1; i >= 0; i--) {
    const child = doc.child(i);
    if (child.type.name === "paragraph" && child.content.size === 0) {
      pos -= child.nodeSize;
      continue;
    }
    break;
  }
  return pos;
}

/** 在文档末尾定点追加一条批注定义。不 closeHistory：与调用方刚完成的 marker
 *  插入事务在 prosemirror-history 的 newGroupDelay 窗口内合并为一步撤销
 *  （「创建批注」= 一次 Ctrl+Z 撤销）。失败返回 false，调用方回退整篇写回。 */
export function appendDefinitionOp(
  ctx: Ctx,
  id: string,
  content: string,
  meta: CodeLineMeta | null
): boolean {
  try {
    const view = ctx.get(editorViewCtx);
    const node = parseDefinitionNode(ctx, buildDefinition(id, content, meta), id);
    if (!node) return false;
    view.dispatch(
      view.state.tr.insert(defInsertPos(view.state.doc), node)
    );
    return true;
  } catch {
    return false;
  }
}

/** 流式/编辑热路径：只替换指定批注的 footnote_definition 节点——ProseMirror
 *  只重渲染变化区间，代码块与其余块的 node view 原样保留。事务照常进历史，
 *  相邻帧由 newGroupDelay 合并；收尾由 finalizeAnnotationOp 收束为一步撤销。
 *  失败时返回原因（TargetedOpResult）：调用方对流式中间态应跳帧而不是整篇
 *  回退（见类型注释）。 */
export function replaceDefinitionOp(
  ctx: Ctx,
  id: string,
  content: string,
  meta: CodeLineMeta | null
): TargetedOpResult {
  try {
    const view = ctx.get(editorViewCtx);
    const region = findDefinitionRegion(view, id);
    if (!region) return { ok: false, reason: "no-def" };
    const node = parseDefinitionNode(ctx, buildDefinition(id, content, meta), id);
    if (!node) return { ok: false, reason: "no-parse" };
    view.dispatch(
      view.state.tr.replaceWith(region.pos, region.pos + region.size, node)
    );
    return { ok: true };
  } catch {
    return { ok: false, reason: "no-parse" };
  }
}

/** 流式收尾（一步撤销契约，定点版）——不依赖 baseline 字符串（v3.9.1 修复：
 *  真实调用链的 baseline 捕获于创建之前，里面永远没有本批注的定义，旧实现
 *  因此必然回退整篇 aiWriteFinalize，代码块被整篇重建两遍——「收尾闪烁」）。
 *  新语义，撤销契约不变（一次 Ctrl+Z 回到批注前）：
 *  ① 单事务无痕删除该批注全部落点（引用 / marker 段 / 定义，
 *    addToHistory=false）——文档回到「批注不存在」状态，期间其他内容不动；
 *  ② closeHistory 单事务按原位放回 marker（段/内联形态与收集时一致）+ 文末
 *    追加最终内容的定义 —— 两步都只触碰批注自己的小区域，代码块 DOM 不动。
 *  marker 已被用户在流式期间删掉时，①只剩定义、②不重建 marker（批注随
 *  用户意图消失）。失败返回 false，调用方回退 aiWriteFinalize。 */
export function finalizeAnnotationOp(
  ctx: Ctx,
  id: string,
  nextContent: string,
  meta: CodeLineMeta | null
): boolean {
  try {
    const view = ctx.get(editorViewCtx);
    const spans = collectAnnotationSpans(view.state.doc, id);
    if (!spans.defRegion) return false;
    const nextNode = parseDefinitionNode(
      ctx,
      buildDefinition(id, nextContent, meta),
      id
    );
    if (!nextNode) return false;

    // ① 无痕删除（同 removeAnnoOp 的区间语义）。
    const dels = dedupeDescending(spans.deletes);
    let tr = view.state.tr;
    for (const r of dels) tr = tr.delete(r.from, r.to);
    if (tr.docChanged) {
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
    }

    // ② 原位重建 + 定义重挂。插入点捕获于删除前的文档坐标——同一批注有
    //  多个 marker 时（复制粘贴产生），位置更靠前的删除会使靠后的插入点
    //  左移，先按「前方已删区间的总长度」折算，再倒序插入（大坐标先插，
    //  小坐标不受影响）；定义追加在当前事务文档末尾（与
    //  appendDefinitionOp 同形态）。
    const removedBefore = (p: number) =>
      dels.reduce((acc, d) => acc + (d.to <= p ? d.to - d.from : 0), 0);
    const schema = view.state.schema;
    const fnType = schema.nodes.footnote_reference;
    const paraType = schema.nodes.paragraph;
    if (!fnType || !paraType) return false;
    let tr2 = view.state.tr;
    for (const ins of [...spans.inserts]
      .map((i) => ({ ...i, pos: i.pos - removedBefore(i.pos) }))
      .sort((a, b) => b.pos - a.pos)) {
      const fn = fnType.create({ label: id });
      tr2 = ins.asParagraph
        ? tr2.insert(ins.pos, paraType.create(null, fn))
        : tr2.insert(ins.pos, fn);
    }
    tr2 = tr2.insert(defInsertPos(tr2.doc), nextNode);
    view.dispatch(closeHistory(tr2));
    return true;
  } catch {
    return false;
  }
}

/** 删除一条批注：单事务删掉定义节点 + 所有同 id 引用节点；引用删除后整段
 *  只剩被删引用的段落一并删除（对齐 removeAnnotationFromMd 的「marker-only
 *  行整行去掉」语义，不留空段落残渣）。定义不存在 → false，调用方回退整篇
 *  removeAnnotationFromMd（孤儿标记场景也走那条路径清引用）。 */
export function removeAnnoOp(ctx: Ctx, id: string): boolean {
  try {
    const view = ctx.get(editorViewCtx);
    const spans = collectAnnotationSpans(view.state.doc, id);
    if (!spans.defRegion) return false;
    const ordered = dedupeDescending(spans.deletes);
    if (ordered.length === 0) return false;
    let tr = view.state.tr;
    for (const r of ordered) tr = tr.delete(r.from, r.to);
    view.dispatch(tr);
    return true;
  } catch {
    return false;
  }
}
