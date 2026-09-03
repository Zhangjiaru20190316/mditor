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

/** 把导出 HTML 里的闪卡容器降级为 blockquote；无闪卡时原样返回。 */
export function degradeFlashcardsInHtml(html: string): string {
  if (!html.includes("md-flashcard")) return html;
  let out = "";
  let last = 0;
  for (const m of html.matchAll(FLASH_OPEN_RE)) {
    const start = m.index ?? 0;
    const closeEnd = findMatchingDivClose(html, start);
    if (closeEnd < 0) continue; // 配对失败：保留原容器（仍可读）
    out += html.slice(last, start);
    // 容器内容原样保留，只换外壳；末尾补一个空行分隔后续块。
    out += `<blockquote class="md-flashcard">${html.slice(
      start + m[0].length,
      closeEnd - "</div>".length
    )}</blockquote>`;
    last = closeEnd;
  }
  out += html.slice(last);
  return out;
}
