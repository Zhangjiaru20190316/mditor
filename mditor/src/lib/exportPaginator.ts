// 自研分页器（EX 轮阶段三）：纯函数——输入「连续铺满内容的块测量面」，
// 输出每页的内容窗口（切片边界）。不做任何 DOM 操作；测量由工厂侧
// measurer 提供（exportPdfPipeline 内），断言与回归全部纯数据驱动。
//
// 模型：页面 = 原始连续布局上的一个 [top, top+contentHeight) 观察窗。
// 分页器只决定「在哪里切」——切片只能落在允许的边界（块间 / 段落与代码
// 块的行间 / 表格的行间），DOM 不重排。每页窗口即光栅化与文本层的取材
// 范围（PDF 组装再把位图放到纸面边距内——内容宽=版心宽，按构造无裁边）。
//
// 契约：blocks 按文档序给出，height 必须覆盖到下一块顶（连续铺满
// [0, 内容总高)——measurer 以相邻块 offsetTop 差计高，天然满足）。

/** 孤儿/寡妇控制：段落类断页时两侧各保留的最少行数。 */
export const MIN_SPLIT_LINES = 2;

export interface SplitLine {
  /** 行盒顶（相对块顶）。 */
  top: number;
  height: number;
}

export interface MeasuredBlock {
  blockId: number;
  /** 块高（含并入的块间距，见模块头契约）。 */
  height: number;
  /** 不允许内部断页（图/公式块/分割线等）——放不下就整体推下页。 */
  keepTogether?: boolean;
  /** 标题类：页尾标题 + 正文在下页 = 孤标题，随推下页。 */
  keepWithNext?: boolean;
  /** 可按行断（p/li/blockquote/pre）。给出行盒即可断。 */
  lines?: SplitLine[];
  /** 表格行盒（按行断；表头不随页重复——已知取舍，见结题报告）。 */
  rows?: SplitLine[];
  /** 断页两侧最少 MIN_SPLIT_LINES 行（段落与代码块开；表格行不控）。 */
  orphanControl?: boolean;
}

export interface PageSegment {
  blockId: number;
  /** 相对块顶的可见区间 [clipTop, clipBottom)。 */
  clipTop: number;
  clipBottom: number;
}

export interface PageWindow {
  /** 窗口顶（content 坐标 = 上一刀的底）。 */
  top: number;
  /** 窗口底（= 本页最后一段的绝对底；下一页从此继续）。 */
  bottom: number;
  segments: PageSegment[];
}

export interface PaginateResult {
  pages: PageWindow[];
  stats: {
    pages: number;
    /** 行级/行盒级断页次数。 */
    splits: number;
    /** keep-together 整体推下页次数。 */
    pushedKeepTogether: number;
    /** 孤儿/寡妇策略整块推下页次数。 */
    orphanWidowPushes: number;
    /** 标题随文推下页次数。 */
    headingPushes: number;
    /** 被迫放置且仍溢出页高的片段（诊断；工厂层图片已钳制，正常应为空）。 */
    clippedSegments: number;
  };
}

/**
 * 把连续内容切成页面窗口。contentHeight ≤ 0 抛错（调用方契约错误）。
 * 空内容返回单空页（导出空文档得到一页白纸，与打印语义一致）。
 */
export function paginateBlocks(
  blocks: MeasuredBlock[],
  contentHeight: number
): PaginateResult {
  if (!(contentHeight > 0)) {
    throw new Error("paginateBlocks: contentHeight 必须为正");
  }
  const stats: PaginateResult["stats"] = {
    pages: 0,
    splits: 0,
    pushedKeepTogether: 0,
    orphanWidowPushes: 0,
    headingPushes: 0,
    clippedSegments: 0,
  };
  if (blocks.length === 0) {
    return {
      pages: [{ top: 0, bottom: 0, segments: [] }],
      stats: { ...stats, pages: 1 },
    };
  }

  // 绝对块顶（契约：连续铺满——height 覆盖到下一块顶）。
  const tops: number[] = new Array(blocks.length);
  const topOfId = new Map<number, number>();
  {
    let acc = 0;
    for (let i = 0; i < blocks.length; i++) {
      tops[i] = acc;
      topOfId.set(blocks[i].blockId, acc);
      acc += blocks[i].height;
    }
  }

  const pages: PageWindow[] = [];
  let idx = 0; // 当前块
  let resume = 0; // 当前块内恢复点（相对块顶；0 = 从块顶开始）
  let windowTop = 0;

  /** 结束当前页：窗口底 = 本页最后一段的绝对底。 */
  const endPage = (segments: PageSegment[]): void => {
    let bottom = windowTop;
    if (segments.length > 0) {
      const s = segments[segments.length - 1];
      bottom = (topOfId.get(s.blockId) ?? 0) + s.clipBottom;
    }
    pages.push({ top: windowTop, bottom, segments });
    stats.pages++;
    windowTop = bottom;
  };

  /** 下一块在 limit 内是否「能落一些内容」（可断块看前两行，排版惯例：
   *  标题 + 至少两行正文同页即可，不必整段跟随）。 */
  const nextCanFollow = (next: MeasuredBlock, startY: number, limit: number): boolean => {
    if (startY + next.height <= limit + 1e-6) return true;
    const units = next.rows ?? next.lines;
    if (!units || units.length === 0) return false;
    const need = Math.min(MIN_SPLIT_LINES, units.length);
    const lastBottomAbs =
      startY + units[need - 1].top + units[need - 1].height;
    return lastBottomAbs <= limit + 1e-6;
  };

  while (idx < blocks.length || pages.length === 0) {
    const limit = windowTop + contentHeight;
    const segments: PageSegment[] = [];
    let placedAnything = false;

    while (idx < blocks.length) {
      const b = blocks[idx];
      const blockTop = tops[idx];
      const blockBottom = blockTop + b.height;
      const effTop = blockTop + resume; // 本块在本页的起点（绝对）

      // 剩余部分整段放得下（含从恢复点续完）。
      if (blockBottom <= limit + 1e-6) {
        const next = blocks[idx + 1];
        if (
          b.keepWithNext &&
          resume === 0 &&
          next &&
          !nextCanFollow(next, blockBottom, limit) &&
          segments.length > 0
        ) {
          stats.headingPushes++;
          break; // 页尾孤标题 → 标题随下页
        }
        segments.push({ blockId: b.blockId, clipTop: resume, clipBottom: b.height });
        idx++;
        resume = 0;
        placedAnything = true;
        continue;
      }

      // 放不下：不可断块。
      if (b.keepTogether || (!b.lines && !b.rows)) {
        if (segments.length === 0) {
          // 页首独占仍溢出（病态；工厂已钳图高，此分支保进度不死循环）。
          segments.push({ blockId: b.blockId, clipTop: resume, clipBottom: b.height });
          stats.clippedSegments++;
          idx++;
          resume = 0;
          placedAnything = true;
        } else {
          stats.pushedKeepTogether++;
        }
        break;
      }

      // 可断块：行/行盒前缀拟合（从恢复点之后的单元起算）。
      const units = (b.rows ?? b.lines) as SplitLine[];
      const isRow = !!b.rows;
      const unitBottoms = units.map((u) => u.top + u.height);
      let first = 0;
      while (first < units.length && unitBottoms[first] <= resume + 1e-6) first++;
      let fitted = first;
      while (
        fitted < units.length &&
        blockTop + unitBottoms[fitted] <= limit + 1e-6
      ) {
        fitted++;
      }

      if (fitted <= first) {
        // 一行都放不下。
        if (segments.length === 0) {
          // 页首必须前进：取恢复点后的第一行（行高 > 页高的病态情形）。
          const cut = Math.min(first + 1, units.length);
          segments.push({
            blockId: b.blockId,
            clipTop: resume,
            clipBottom: cut >= units.length ? b.height : unitBottoms[cut - 1],
          });
          stats.clippedSegments++;
          if (cut >= units.length) {
            idx++;
            resume = 0;
          } else {
            resume = unitBottoms[cut - 1];
          }
          placedAnything = true;
        } else if (isRow || !b.orphanControl) {
          stats.pushedKeepTogether++;
        } else {
          stats.orphanWidowPushes++;
        }
        break;
      }

      // 孤儿/寡妇：断点两侧各 ≥ MIN_SPLIT_LINES（只对段落/代码类的行断开）。
      let cut = fitted;
      if (b.orphanControl && !isRow) {
        const remainAfter = units.length - cut;
        if (
          remainAfter > 0 &&
          remainAfter < MIN_SPLIT_LINES &&
          units.length > MIN_SPLIT_LINES
        ) {
          cut = units.length - MIN_SPLIT_LINES; // 寡妇回收：尾部留足
        }
        const placedHere = cut - first;
        if (
          placedHere > 0 &&
          placedHere < MIN_SPLIT_LINES &&
          units.length > MIN_SPLIT_LINES &&
          segments.length > 0
        ) {
          cut = first; // 孤儿回收：页尾只挂 1 行 → 整段下移
        }
      }
      if (cut <= first && segments.length > 0) {
        stats.orphanWidowPushes++;
        break;
      }
      if (cut <= first) {
        cut = Math.min(fitted, units.length); // 页空必须前进（接受孤儿/寡妇）
      }
      const whole = cut >= units.length;
      const clipBottom = whole ? b.height : unitBottoms[cut - 1];
      segments.push({ blockId: b.blockId, clipTop: resume, clipBottom });
      if (!whole) stats.splits++;
      if (whole) {
        idx++;
        resume = 0;
      } else {
        resume = clipBottom;
      }
      placedAnything = true;
      break; // 本页刀口已落
    }

    endPage(segments);
    if (!placedAnything && idx < blocks.length) {
      // 理论不可达（页首前进保障）；防死循环兜底。
      throw new Error("paginateBlocks: 分页停滞（契约被破坏：块不连续？）");
    }
    if (pages.length > 100_000) throw new Error("paginateBlocks: 页数失控");
  }

  return { pages, stats };
}
