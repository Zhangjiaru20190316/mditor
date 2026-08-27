// mathNumbering（v4.6）纯函数行为锚点：\label 收集/剥除、显式 \tag 与
// \notag 语义、自动编号分配、\ref/\eqref 解析。静态管线与导出路径共享这一
// 核心，两端的适配器（remarkMathNumbering / exportMath）各自另有集成测试。
import { describe, expect, it } from "vitest";
import {
  assignNumbers,
  harvestMathMeta,
  injectAutoTag,
  resolveRefsInLatex,
} from "./mathNumbering";

describe("harvestMathMeta", () => {
  it("提取并剥除 \\label，其余内容原样", () => {
    const m = harvestMathMeta("E=mc^2 \\label{eq:e}");
    expect(m.label).toBe("eq:e");
    expect(m.latex).toBe("E=mc^2 ");
    expect(m.hasExplicitTag).toBe(false);
  });

  it("显式 \\tag 被探测，编号文本保留", () => {
    const m = harvestMathMeta("a=b \\tag{3a} \\label{x}");
    expect(m.hasExplicitTag).toBe(true);
    expect(m.explicitTagText).toBe("3a");
  });

  it("\\notag / \\nonumber 视为显式不要编号", () => {
    expect(harvestMathMeta("a=b \\notag").hasExplicitTag).toBe(true);
    expect(harvestMathMeta("a=b \\nonumber").hasExplicitTag).toBe(true);
    expect(harvestMathMeta("a=b \\notag").explicitTagText).toBeNull();
  });
});

describe("assignNumbers", () => {
  const metas = [
    harvestMathMeta("a=b \\label{eq:a}"),
    harvestMathMeta("c=d \\tag{9} \\label{eq:c}"), // 显式 tag：用 9，不占序号
    harvestMathMeta("e=f \\notag"), // 显式不要编号
    harvestMathMeta("g=h \\label{eq:g}"),
  ];

  it("autoNumber：按序编号，显式 \\tag 用作者编号，\\notag 跳过", () => {
    const a = assignNumbers(metas, true);
    expect(a.numbers).toEqual(["1", "9", null, "2"]);
    expect(a.autoTagIndexes.has(0)).toBe(true);
    expect(a.autoTagIndexes.has(1)).toBe(false);
    expect(a.autoTagIndexes.has(3)).toBe(true);
    expect(a.labelMap.get("eq:a")).toBe("1");
    expect(a.labelMap.get("eq:c")).toBe("9");
    expect(a.labelMap.has("eq:g")).toBe(true);
  });

  it("autoNumber 关闭：全部不编号、labelMap 为空（\\ref 保持字面）", () => {
    const a = assignNumbers(metas, false);
    expect(a.numbers).toEqual([null, "9", null, null]); // 显式 tag 仍保留
    expect(a.labelMap.get("eq:c")).toBe("9");
    expect(a.labelMap.has("eq:a")).toBe(false);
  });
});

describe("injectAutoTag / resolveRefsInLatex", () => {
  it("自动编号注入在源码末尾", () => {
    expect(injectAutoTag("a=b ", "3")).toBe("a=b \\tag{3}");
  });

  it("\\ref → 编号，\\eqref → (编号)，未知 key 原样", () => {
    const map = new Map([["eq:a", "1"], ["eq:c", "9"]]);
    expect(resolveRefsInLatex("见 \\ref{eq:a} 与 \\eqref{eq:c}", map)).toBe(
      "见 1 与 (9)"
    );
    expect(resolveRefsInLatex("\\ref{missing}", map)).toBe("\\ref{missing}");
  });

  it("空 labelMap 直接短路返回", () => {
    const src = "\\ref{eq:a}";
    expect(resolveRefsInLatex(src, new Map())).toBe(src);
  });
});
