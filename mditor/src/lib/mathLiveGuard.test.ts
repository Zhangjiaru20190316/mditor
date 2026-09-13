// mathLiveGuard（v4.12.1）的行为锚点：输入规则绕过 remark，键入 `范围
// $1-$10 之间` 在第二个 `$` 敲下的瞬间仍会生成 math_inline("1-") 假公式
// 节点。这里锁定实时降级插件的扫描与判定语义——与 lib/remarkMathGuard 的
// 两条规则（首尾空白 / 闭 $ 后跟数字）完全一致，合法公式零误伤。
//
// 用最小 ProseMirror Schema 直接构造文档验证（不起编辑器）；appendTransaction
// 的端到端行为用 EditorState.apply 触发（PM 会自动执行插件的 append 链）。
import { describe, expect, it } from "vitest";
import { Schema, type Node as PMNode } from "@milkdown/prose/model";
import { EditorState, type Transaction } from "@milkdown/prose/state";
import {
  findMathGuardViolations,
  mathLiveGuardPlugin,
  mathValueViolatesGuard,
  nextTextStartsWithDigit,
} from "./mathLiveGuard";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    math_inline: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: () => ["span", 0],
    },
  },
});

type Inline = string | { math: string };

function para(...inline: Inline[]): PMNode {
  const kids = inline.map((c) =>
    typeof c === "string"
      ? schema.text(c)
      : schema.nodes.math_inline.create({ value: c.math })
  );
  return schema.nodes.paragraph.create(null, kids);
}

function docOf(...blocks: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, blocks);
}

/** 文档的源码形态文本：文本节点原样、math_inline 包回 `$…$`（textContent
 *  对无 leafText 的 atom 叶子贡献空串，不能用）。 */
function docText(d: PMNode): string {
  let out = "";
  d.descendants((n) => {
    if (n.isText) out += n.text;
    else if (n.type.name === "math_inline") out += `$${n.attrs.value}$`;
    return true;
  });
  return out;
}

function countMath(d: PMNode): number {
  let n = 0;
  d.descendants((node) => {
    if (node.type.name === "math_inline") n++;
    return true;
  });
  return n;
}

describe("mathValueViolatesGuard（两条规则纯判定）", () => {
  it("规则 1：首尾空白违规", () => {
    expect(mathValueViolatesGuard(" x ", null)).toBe(true);
    expect(mathValueViolatesGuard("x ", null)).toBe(true);
    expect(mathValueViolatesGuard(" x", null)).toBe(true);
  });

  it("规则 2：闭 $ 后紧跟数字违规（`$1-$10` 价格区间）", () => {
    expect(mathValueViolatesGuard("1-", "10 之间")).toBe(true);
  });

  it("后继文本以空白开头不违规（`$x$ 2` 是合法公式+正文）", () => {
    expect(mathValueViolatesGuard("x", " 2")).toBe(false);
  });

  it("干净值且无后继数字 → 不违规", () => {
    expect(mathValueViolatesGuard("x^2", null)).toBe(false);
    expect(mathValueViolatesGuard("x_1", " 保持")).toBe(false);
  });

  it("nextTextStartsWithDigit 边界", () => {
    expect(nextTextStartsWithDigit("2")).toBe(true);
    expect(nextTextStartsWithDigit("")).toBe(false);
    expect(nextTextStartsWithDigit(null)).toBe(false);
    expect(nextTextStartsWithDigit(undefined)).toBe(false);
  });
});

describe("findMathGuardViolations（区间扫描）", () => {
  it("`范围 $1-$10 之间`：后继数字 → 命中", () => {
    const d = docOf(para("范围 ", { math: "1-" }, "10 之间"));
    // 段落内容从 pos 1 开始："范围 "（3 字）→ math 起点 pos 4。
    const hits = findMathGuardViolations(d, [{ from: 0, to: d.content.size }]);
    expect(hits).toHaveLength(1);
    expect(hits[0].pos).toBe(4);
    expect(hits[0].node.attrs.value).toBe("1-");
  });

  it("`公式 $x^2$ 保持`：合法公式不命中", () => {
    const d = docOf(para("公式 ", { math: "x^2" }, " 保持"));
    expect(findMathGuardViolations(d, [{ from: 0, to: d.content.size }])).toHaveLength(0);
  });

  it("`$x_1$2`（无空格紧贴数字）命中——与 GitHub 语义一致", () => {
    const d = docOf(para({ math: "x_1" }, "2 种"));
    expect(findMathGuardViolations(d, [{ from: 0, to: d.content.size }])).toHaveLength(1);
  });

  it("`$x_1$ 2`（空格分隔）不命中", () => {
    const d = docOf(para({ math: "x_1" }, " 2 种"));
    expect(findMathGuardViolations(d, [{ from: 0, to: d.content.size }])).toHaveLength(0);
  });

  it("首尾空白的值命中（toggleInlineMath 等其他创建路径的兜底）", () => {
    const d = docOf(para({ math: " a " }));
    const hits = findMathGuardViolations(d, [{ from: 0, to: d.content.size }]);
    expect(hits).toHaveLength(1);
  });

  it("区间不覆盖节点 → 不命中；重叠区间去重", () => {
    const d = docOf(para("abc ", { math: "1-" }, "10"));
    // math 起点在 pos 5（"abc " 4 字 + 段落内容起点 1）。
    expect(findMathGuardViolations(d, [{ from: 0, to: 4 }])).toHaveLength(0);
    const dup = findMathGuardViolations(d, [
      { from: 0, to: d.content.size },
      { from: 3, to: 8 },
    ]);
    expect(dup).toHaveLength(1);
  });

  it("多段落混合：只命中违规者", () => {
    const d = docOf(para({ math: "1-" }, "10"), para({ math: "E" }, " 好的"));
    const hits = findMathGuardViolations(d, [{ from: 0, to: d.content.size }]);
    expect(hits).toHaveLength(1);
    expect(hits[0].node.attrs.value).toBe("1-");
  });
});

describe("mathLiveGuardPlugin（appendTransaction 端到端）", () => {
  const state0 = EditorState.create({
    doc: docOf(para("范围 ")),
    plugins: [mathLiveGuardPlugin()],
  });

  it("打字模拟：math_inline 后补敲数字 → 同事务链降级回字面 `$…$`", () => {
    // 输入规则产物：`范围 $1-$` 的瞬间（"1-" 成节点，无后继文本）。
    const t1: Transaction = state0.tr.replaceWith(
      4,
      4,
      schema.nodes.math_inline.create({ value: "1-" })
    );
    const s1 = state0.apply(t1);
    // 无后继数字时暂不降级（`$1-$` 本身形态合法——GitHub 同为公式）。
    expect(docText(s1.doc)).toBe("范围 $1-$");
    // 继续敲 `10`（落在节点后）→ appendTransaction 降级为字面文本。
    const size = s1.doc.content.size;
    const t2: Transaction = s1.tr.insertText("10", size - 1);
    const s2 = s1.apply(t2);
    expect(docText(s2.doc)).toBe("范围 $1-$10");
    expect(countMath(s2.doc)).toBe(0);
  });

  it("合法公式打字零扰动", () => {
    const st = EditorState.create({
      doc: docOf(para({ math: "x^2" }, " 保持")),
      plugins: [mathLiveGuardPlugin()],
    });
    const t: Transaction = st.tr.insertText("!", st.doc.content.size - 1);
    const s1 = st.apply(t);
    expect(docText(s1.doc)).toBe("$x^2$ 保持!");
    expect(countMath(s1.doc)).toBe(1);
  });

  it("远端编辑不波及既有违规——live 只扫事务区间，全文清扫归 remark guard", () => {
    const st = EditorState.create({
      doc: docOf(para({ math: "1-" }, "10"), para("尾部")),
      plugins: [mathLiveGuardPlugin()],
    });
    // 在文档末段追加字符：变更区间远离违规节点 → 不降级（也不循环）。
    const t: Transaction = st.tr.insertText("!", st.doc.content.size - 1);
    const s1 = st.apply(t);
    expect(countMath(s1.doc)).toBe(1);
    expect(docText(s1.doc)).toBe("$1-$10尾部!");
  });
});
