// 批注弹层的纯几何摆位算法。从 AnnotationPopover 抽出（v3.9.1）：
// ① 便于单测（四候选选择 / 徽章避让 / 锚点自避让 / 兜底钳位，零 DOM 依赖）；
// ② 修复「兜底钳位把卡片压在被点的徽章上」——避让集必须包含锚点自身，
//    否则窄窗口/贴边徽章的下一击会落在卡片上被 contains 守卫静默吞掉
//    （「要点两次」的形态之一）。

export interface PlaceBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PlacePos {
  left: number;
  top: number;
}

/** 视口的纵向可用边界（v3.9.4）。fixed 卡片参与根层叠上下文，摆位必须
 * 避开 app chrome（标题栏+标签栏在上、状态栏在下）——此前钳位只认
 * 8px / vh-160，卡片可停在 y≈8 处整片盖住 36px 标题栏。 */
export interface PlaceBounds {
  /** 允许的最小 top（如 标题栏+标签栏实际高度 + 8）。 */
  top: number;
  /** 允许的 top+cardH 上界（如 vh - 状态栏高度 - 8）。 */
  bottom: number;
}

/**
 * 为弹层卡片选一个视口位置：紧贴锚点、不遮任何徽章（含锚点自身——
 * 被卡片盖住的徽章在弹层打开期间不可点击）。候选顺序：右 / 左（顶对齐）、
 * 右 / 左（锚点下方）。全部候选压徽章或出屏时钳位进视口，并强制把卡片
 * 挪到锚点上方或下方（宁可离锚点远一点，也不盖住触发它的徽章）。
 * 纯几何：调用方传缓存盒，滚动帧重摆位对其他徽章零 DOM 测量。
 * bounds 缺省时退回旧的裸视口钳位（8px / vh-160）。
 */
export function placeCard(
  anchor: PlaceBox,
  others: PlaceBox[],
  card: { w: number; h: number },
  bounds?: PlaceBounds
): PlacePos {
  const cardW = card.w;
  const cardH = card.h;
  const margin = 8;
  const pad = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 纵向可用区间：有 chrome 边界用之，否则退回历史钳位（top ∈ [8, vh-160]）。
  const topMin = bounds ? Math.max(margin, bounds.top) : margin;
  const topMax = bounds ? bounds.bottom - cardH : vh - 160;
  // 锚点自身也在避让集里：紧邻锚点的候选不会误伤（候选起点已在锚点
  // 边界 + margin 之外），但钳位/贴边候选会被正确拒绝。
  const avoid = [...others, anchor];
  const hits = (left: number, top: number) =>
    avoid.some(
      (r) =>
        left < r.right + pad &&
        left + cardW > r.left - pad &&
        top < r.bottom + pad &&
        top + cardH > r.top - pad
    );
  const inViewport = (left: number, top: number) =>
    left >= margin &&
    left + cardW <= vw - margin &&
    top >= topMin &&
    top <= topMax;
  const candidates: PlacePos[] = [
    { left: anchor.right + margin, top: anchor.top },
    { left: anchor.left - margin - cardW, top: anchor.top },
    { left: anchor.right + margin, top: anchor.bottom + margin },
    { left: anchor.left - margin - cardW, top: anchor.bottom + margin },
  ];
  for (const c of candidates) {
    if (inViewport(c.left, c.top) && !hits(c.left, c.top)) return c;
  }
  // 每个候选都压到徽章或出屏：先按老逻辑钳位进视口……
  let left = anchor.right + margin;
  if (left + cardW > vw - margin) left = anchor.left - margin - cardW;
  if (left < margin) left = margin;
  let top = anchor.top;
  if (top > topMax) top = Math.max(topMin, topMax);
  // ……锚点在 chrome 区间之上（视口顶部）时把卡片抬回区间内（topMin 与
  // topMax 交叉的极窄视口退化为 topMin）。
  if (top < topMin) top = topMin;
  // ……再保证不盖锚点：能挪下方挪下方，放不下再挪上方。
  const overlapsAnchor = (l: number, t: number) =>
    l < anchor.right + pad &&
    l + cardW > anchor.left - pad &&
    t < anchor.bottom + pad &&
    t + cardH > anchor.top - pad;
  if (overlapsAnchor(left, top)) {
    const below = anchor.bottom + margin;
    if (below <= topMax) {
      top = below;
    } else {
      top = Math.max(topMin, anchor.top - margin - cardH);
    }
    if (top > topMax) top = Math.max(topMin, topMax);
  }
  return { left, top };
}

/** 把跟随滚动算术平移后的 top 钳回可用区间（placeCard 的滚动帧版）。
 *  卡片钉在边界上等锚点滚回来，而不是跟着滚出屏/盖住 chrome 栏。 */
export function clampTop(
  top: number,
  cardH: number,
  bounds: PlaceBounds
): number {
  const max = bounds.bottom - cardH;
  if (max < bounds.top) return bounds.top;
  return Math.min(Math.max(top, bounds.top), max);
}
