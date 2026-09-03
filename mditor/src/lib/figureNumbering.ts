// 图表编号与交叉引用的纯函数（模块 3）：图片 `{#fig:id}` 属性、表格
// `: caption {#tbl:id}` 说明行、正文 `@fig:id` / `@tbl:id` 引用的解析与
// 编号映射。静态渲染（remarkFigureNumbering）与 LaTeX 导出（exportLatex）
// 共用这一份实现，保证编号三处一致。
//
// 语法规范（docs/research-features.md）：
//   ![标题文字](image.png){#fig:myid}   ← 图片属性（紧跟图片，同段或下一行）
//   : 表格标题 {#tbl:myid}              ← 表格说明行（表格前一行或后一行）
//   见 @fig:myid / 如 @tbl:myid 所示     ← 正文引用 → 「图 1」/「表 2」

export interface FigureAttr {
  kind: "fig" | "tbl";
  id: string;
}

/** `{#fig:myid}` / `{#tbl:myid}` 整段文本匹配（容许首尾空白）。 */
export function parseFigureAttr(text: string): FigureAttr | null {
  const m = text.match(/^\s*\{#(fig|tbl):([A-Za-z0-9_\-.:]+)\}\s*$/);
  return m ? { kind: m[1] as "fig" | "tbl", id: m[2] } : null;
}

export interface TableCaption {
  caption: string;
  /** null = 无 id 的普通 `: caption` 行（不参与编号，保持原样）。 */
  id: string | null;
}

/** `: 表格标题 {#tbl:myid}` / `: 表格标题`（后者无 id 不编号）。 */
export function parseTableCaption(text: string): TableCaption | null {
  const m = text.match(/^:\s+(.+?)(?:\s*\{#tbl:([A-Za-z0-9_\-.:]+)\})?\s*$/);
  if (!m) return null;
  return { caption: m[1].trim(), id: m[2] ?? null };
}

/** 正文引用替换：@fig:id → 「图 N」、@tbl:id → 「表 N」（未定义 id 原样保留）。 */
export function resolveFigureRefs(
  text: string,
  figs: Map<string, number>,
  tbls: Map<string, number>,
  labels: { fig: string; tbl: string } = { fig: "图", tbl: "表" }
): string {
  return text.replace(/@(fig|tbl):([A-Za-z0-9_\-.:]+)/g, (whole, kind: string, id: string) => {
    const map = kind === "fig" ? figs : tbls;
    const n = map.get(id);
    if (n === undefined) return whole;
    return `${kind === "fig" ? labels.fig : labels.tbl} ${n}`;
  });
}

/** 按出现序分配编号（首个出现即占号；重复 id 不重编）。 */
export class FigureNumbering {
  private figs = new Map<string, number>();
  private tbls = new Map<string, number>();
  private figCount = 0;
  private tblCount = 0;

  /** 给 id 分配（或返回已有）编号。 */
  assign(kind: "fig" | "tbl", id: string): number {
    const map = kind === "fig" ? this.figs : this.tbls;
    const hit = map.get(id);
    if (hit !== undefined) return hit;
    const n = kind === "fig" ? ++this.figCount : ++this.tblCount;
    map.set(id, n);
    return n;
  }

  figNumbers(): Map<string, number> {
    return this.figs;
  }

  tblNumbers(): Map<string, number> {
    return this.tbls;
  }

  fig(id: string): number | undefined {
    return this.figs.get(id);
  }

  tbl(id: string): number | undefined {
    return this.tbls.get(id);
  }
}
