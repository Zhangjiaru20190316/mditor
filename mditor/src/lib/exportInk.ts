// 导出链公用的「墨迹盒」测量（MC 轮）：KaTeX / SVG 等矢量子树的绘制墨迹
// 可以越出布局盒——KaTeX vlist 的零高行盒（\sum 上下限、行内高公式栈）实测
// 墨迹越盒上方 5~24px，超宽 display 公式（white-space:nowrap）越盒右侧可达
// 数百 px。一切「按布局盒裁剪/栅格化」的路径（PDF 补丁矩形、DOCX 公式
// 栅格化、超宽公式缩放归一）都会因此削掉笔画——本模块给出子树真实墨迹的
// 联合矩形：文本 run 的 Range 客户端矩形 + svg 元素盒。
//
// 与 measureBlocks 的行盒护量（INK_GUARD_MAX_PX，刀口不剃进笔画的应急外扩）
// 互补：那是「行盒之外再放多少」的保守上限；这里是墨迹面本身的实测。

/** 墨迹联合矩形（视口坐标，与 getBoundingClientRect 同系）。 */
export interface InkRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 补丁/栅格化矩形外扩护量（CSS px）：吸收字形 em 盒外的悬挂（字肩/字脚
 *  的抗锯齿边）与 1px 采样舍入。与 exportPdfPipeline.INK_GUARD_MAX_PX 同量级。 */
export const INK_PAD_PX = 3;

/**
 * 元素子树内可见墨迹的联合矩形（视口坐标）。跳过 KaTeX 的隐藏 MathML
 * （.katex-mathml——无绘制墨迹）；pstrut/strut 等空撑高元素天然无文本 run
 * 矩形，不计入。无任何墨迹（空元素）返回 null。
 */
export function inkRectOf(el: Element): InkRect | null {
  const doc = el.ownerDocument;
  if (!doc) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const add = (r: { left: number; right: number; top: number; bottom: number }): void => {
    if (r.right <= r.left && r.bottom <= r.top) return;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  };
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!(node.data ?? "").trim()) continue;
    const p = node.parentElement;
    if (!p || p.closest(".katex-mathml")) continue;
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) add(r);
  }
  for (const s of Array.from(el.querySelectorAll("svg"))) {
    add(s.getBoundingClientRect());
  }
  // 元素自身是 svg（KaTeX sqrt/矢量箭头等）：querySelectorAll 不含自身。
  if (typeof SVGElement !== "undefined" && el instanceof SVGElement) {
    add(el.getBoundingClientRect());
  }
  if (left === Infinity) return null;
  return { left, top, right, bottom };
}

/**
 * 墨迹盒外扩护量并横向钳制在版心内（[0, contentWidth]）——补丁从 chunk 位图
 * 裁剪时源矩形若越出位图边界，cropPatch 的 clamp 会造成「裁小画大」的错位
 * 拉伸；钳制保证补丁矩形与位图可见域一致。纵向不钳（跨页切分由
 * patchWindowSeg 按页窗口处理）。
 */
export function padAndClampInkRect(
  ink: InkRect,
  contentWidth: number
): { x: number; y: number; w: number; h: number } {
  const x1 = Math.max(0, ink.left - INK_PAD_PX);
  const x2 = Math.min(contentWidth, ink.right + INK_PAD_PX);
  return {
    x: x1,
    y: ink.top - INK_PAD_PX,
    w: Math.max(0, x2 - x1),
    h: ink.bottom - ink.top + 2 * INK_PAD_PX,
  };
}
