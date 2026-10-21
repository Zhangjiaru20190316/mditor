// RV 轮阶段三：局部光栅补丁的纯逻辑面。补丁 = 「未能矢量绘制的视觉」在
// 位图里的裁剪矩形（公式块/代码块整块、行内公式/SVG 片段、残留影子文本
// 的行盒并集），按页窗口裁切后以 PNG 嵌入对应位置——满铺位图由此退位。
//
// 不变量：每个非矢量视觉恰好有一个补丁覆盖其墨迹（块补丁优先，行内补丁
// 次之，残留 run 补丁兜底）；纯矢量页零补丁。

/** 补丁源（content 坐标，CSS px，border-box）。 */
export interface PatchSource {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 页内补丁（页坐标 = content 坐标 − 页窗口顶；跨页块被窗口切开）。 */
export interface PagePatch {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageLike {
  top: number;
  bottom: number;
}

/** 补丁源与页窗口的可见 y 区间（半开 [top,bottom)，边界含入；无相交 null）。 */
export function patchWindowSeg(
  y: number,
  h: number,
  wTop: number,
  wBottom: number,
  eps = 0.01
): [number, number] | null {
  const lo = y;
  const hi = y + h;
  if (hi < wTop - eps || lo > wBottom + eps) return null;
  return [Math.max(lo, wTop), Math.min(hi, wBottom)];
}

/** 补丁源 → 逐页放置（纯函数；窗口外的部分丢弃，跨页块切给两页）。 */
export function patchesToPagePlacements(
  sources: PatchSource[],
  pages: PageLike[]
): PagePatch[][] {
  const out: PagePatch[][] = pages.map(() => []);
  for (const s of sources) {
    if (s.w <= 0 || s.h <= 0) continue;
    for (let i = 0; i < pages.length; i++) {
      const seg = patchWindowSeg(s.y, s.h, pages[i].top, pages[i].bottom);
      if (!seg) continue;
      out[i].push({
        x: s.x,
        y: seg[0] - pages[i].top,
        w: s.w,
        h: seg[1] - seg[0],
      });
    }
  }
  return out;
}

/** 矩形并（residual 片段合并用）。 */
export function unionRects(
  rects: PatchSource[]
): PatchSource {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 纵向相邻矩形的合并（间隙 ≤ vGap 视为同一补丁——行间留白并入，避免
 *  补丁缝露底）。横向不合并（同行多个加粗词各自紧凑）。 */
export function mergeRectsVertically(
  rects: PatchSource[],
  vGap = 6
): PatchSource[] {
  if (rects.length === 0) return [];
  const sorted = [...rects].sort((a, b) => a.y - b.y);
  const out: PatchSource[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.y <= cur.y + cur.h + vGap) {
      const x2 = Math.max(cur.x + cur.w, r.x + r.w);
      cur = {
        x: Math.min(cur.x, r.x),
        y: cur.y,
        w: 0,
        h: Math.max(cur.y + cur.h, r.y + r.h) - cur.y,
      };
      cur.w = x2 - cur.x;
    } else {
      out.push(cur);
      cur = { ...r };
    }
  }
  out.push(cur);
  return out;
}
