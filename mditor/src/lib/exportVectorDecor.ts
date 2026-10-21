// RV 轮阶段二：矢量装饰的纯逻辑面 —— 装饰几何（content 坐标）→ 页内
// 绘制计划（rect/line 裁剪 + 跨页表格断口补线）。DOM 采集在
// exportPdfPipeline（collectBlockDecorations / 文本侧 run 装饰），组装在
// exportPdfAssembly（drawRectangle / drawLine）；本模块只做可单测的几何。

/** 矩形装饰（引用底色/左竖条/mark 高亮背景）。content 坐标，CSS px。 */
export interface DecoRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: { r: number; g: number; b: number };
}

/** 线装饰（表格边框/单元格内线/hr/下划线/删除线/断口补线）。 */
export interface DecoLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** CSS px（换算 pt 由组装器统一 k 比）。 */
  width: number;
  color: { r: number; g: number; b: number };
}

/** 页内绘制计划（页坐标 = content 坐标 − 页窗口顶）。 */
export interface PageDeco {
  rects: DecoRect[];
  lines: DecoLine[];
}

export interface PageLike {
  top: number;
  bottom: number;
}

/** 线段与页窗口的可见 y 区间（半开 [top,bottom) + 边界含入：断口补线落在
 *  窗口边界时两侧页都要画——用闭区间并 clamp，无相交返回 null）。 */
export function clipLineToWindow(
  y1: number,
  y2: number,
  wTop: number,
  wBottom: number,
  eps = 0.01
): [number, number] | null {
  const lo = Math.min(y1, y2);
  const hi = Math.max(y1, y2);
  if (hi < wTop - eps || lo > wBottom + eps) return null;
  return [Math.max(lo, wTop), Math.min(hi, wBottom)];
}

/**
 * 装饰 → 逐页绘制计划（纯函数）：
 *   * rect/line 按页窗口裁剪（跨界装饰切开分属两页——表格行边线跨页即此）；
 *   * 表格断口补线：页刀口切进表格纵向范围时，在刀口两侧页的切口上补
 *     横线（页底闭合 + 续页页首闭合），线宽/色取表格单元格边框实测值。
 */
export function decorationsToPageDecos(
  deco: { rects: DecoRect[]; lines: DecoLine[]; tables: TableSpan[] },
  pages: PageLike[]
): PageDeco[] {
  const out: PageDeco[] = pages.map(() => ({ rects: [], lines: [] }));
  const cutYs = pages.slice(1).map((p) => p.top);
  const cutSet = new Set(cutYs);
  for (let i = 0; i < pages.length; i++) {
    const wTop = pages[i].top;
    const wBottom = pages[i].bottom;
    for (const r of deco.rects) {
      const seg = clipLineToWindow(r.y, r.y + r.h, wTop, wBottom);
      if (!seg) continue;
      out[i].rects.push({ ...r, y: seg[0] - wTop, h: seg[1] - seg[0] });
    }
    for (const l of deco.lines) {
      const seg = clipLineToWindow(l.y1, l.y2, wTop, wBottom);
      if (!seg) continue;
      out[i].lines.push({
        ...l,
        y1: seg[0] - wTop,
        y2: seg[1] - wTop,
      });
    }
    // 表格断口补线：本页窗口的上/下边若恰为分页刀口且切在表格纵向范围内
    // → 在切口上补横线（页底闭合 + 续页页首闭合，两侧页各画各的半边）。
    for (const t of deco.tables) {
      for (const cut of [wTop, wBottom]) {
        if (!cutSet.has(cut)) continue; // 必须是真实刀口（页 0 顶/末页底不算）
        if (cut <= t.top + 1 || cut >= t.bottom - 1) continue;
        out[i].lines.push({
          x1: t.x1,
          y1: cut - wTop,
          x2: t.x2,
          y2: cut - wTop,
          width: t.borderWidth,
          color: t.color,
        });
      }
    }
  }
  return out;
}

/** 表格纵向范围（断口补线输入；x 取表格外框横向范围）。 */
export interface TableSpan {
  x1: number;
  x2: number;
  top: number;
  bottom: number;
  borderWidth: number;
  color: { r: number; g: number; b: number };
}

/**
 * 下划线/删除线几何（纯函数；近似 Chromium 默认位置——DOM 不暴露装饰线
 * 实测位，视觉验收校准）：
 *   underline：基线下 0.10em；line-through：基线上 0.30em；
 *   线宽 = max(1px, 0.047em)（与 UA 默认 1px/auto 接近）。
 */
export function decorationLineGeometry(
  baselineY: number,
  size: number,
  kind: "underline" | "line-through"
): { y: number; thickness: number } {
  const thickness = Math.max(1, size * 0.047);
  const y =
    kind === "underline" ? baselineY + size * 0.1 : baselineY - size * 0.3;
  return { y, thickness };
}
