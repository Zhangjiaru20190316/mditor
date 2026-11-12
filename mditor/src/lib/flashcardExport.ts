// 导出链路的闪卡降级（铁律 6，模块 4）：编辑器 getHTML() 里的闪卡是
// `<div class="md-flashcard" data-flashcard="1">…</div>` 卡片容器。导出产物
// 离开本工具必须可读：容器降级为普通 blockquote（与静态渲染的
// remarkFlash render 模式同语义）。
//
// 纯字符串后处理（DOM 无关），div 配对用深度计数（嵌套 div 不误伤）。

const FLASH_OPEN_RE = /<div class="md-flashcard" data-flashcard="1">/g;

function findMatchingDivClose(html: string, openStart: number): number {
  let depth = 0;
  let i = openStart;
  while (i < html.length) {
    const nextOpen = earliest(html, i, ["<div"]);
    const nextClose = earliest(html, i, ["</div>"]);
    if (nextClose.idx < 0) return -1;
    if (nextOpen.idx >= 0 && nextOpen.idx < nextClose.idx) {
      depth++;
      i = nextOpen.idx + nextOpen.len;
    } else {
      depth--;
      if (depth <= 0) return nextClose.idx + nextClose.len;
      i = nextClose.idx + nextClose.len;
    }
  }
  return -1;
}

function earliest(html: string, from: number, needles: string[]): { idx: number; len: number } {
  let best = { idx: -1, len: 0 };
  for (const n of needles) {
    const i = html.indexOf(n, from);
    if (i >= 0 && (best.idx < 0 || i < best.idx)) best = { idx: i, len: n.length };
  }
  return best;
}

/** 把导出 HTML 里的闪卡容器降级为 blockquote；无闪卡时原样返回。
 *
 * 嵌套闪卡（PM schema 允许 block 嵌套，deepAssemble 显式支持）：matchAll
 * 的匹配位置在外卡替换后落在已消费区间内——单趟遍历若照常处理，内卡会被
 * 二次降级、外卡后半内容重复输出且残留孤立 `</div>`（MC 轮 P1 定罪：全部
 * 富格式导出路径共用本函数）。改为多趟归一：每趟只处理互不嵌套的最外层，
 * 内卡随趟数逐层降级，直到无闪卡容器（深度上限 10 防御）。 */
export function degradeFlashcardsInHtml(html: string): string {
  let cur = html;
  for (let pass = 0; pass < 10; pass++) {
    if (!cur.includes("md-flashcard")) return cur;
    let out = "";
    let last = 0;
    let replaced = false;
    for (const m of cur.matchAll(FLASH_OPEN_RE)) {
      const start = m.index ?? 0;
      if (start < last) continue; // 嵌套内卡：留待下一趟（当前是外卡内容原文）
      const closeEnd = findMatchingDivClose(cur, start);
      if (closeEnd < 0) continue; // 配对失败：保留原容器（仍可读）
      out += cur.slice(last, start);
      // 容器内容原样保留，只换外壳。
      out += `<blockquote class="md-flashcard">${cur.slice(
        start + m[0].length,
        closeEnd - "</div>".length
      )}</blockquote>`;
      last = closeEnd;
      replaced = true;
    }
    if (!replaced) return cur; // 只剩配对失败的残卡：不再循环
    out += cur.slice(last);
    cur = out;
  }
  return cur;
}
