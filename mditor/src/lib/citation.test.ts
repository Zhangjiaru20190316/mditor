// 引用格式化纯函数测试（模块 3）：解析语法、两种样式行内形态、编号分配、
// 参考文献表（numeric 引用序 / author-year 字母序）——「渲染/编号/导出三处
// 一致」的共同基座。

import { describe, expect, it } from "vitest";
import { parseBibtex, type BibEntry } from "./bibtex";
import {
  assignCitationNumbers,
  authorShort,
  authorYearText,
  buildReferences,
  formatInlineCitation,
  formatReference,
  isReferencesHeadingText,
  parseCitationInner,
} from "./citation";

const { entries } = parseBibtex(`
@article{smith2020,
  author = {Smith, John and Lee, Kate},
  title = {A Study of Things},
  journal = {Journal of Examples},
  year = {2020},
  volume = {12},
  number = {3},
  pages = {45--67},
  doi = {10.1000/xyz123}
}
@inproceedings{lee2021,
  author = {Lee, Kate and Wu, Ada and Chen, Li},
  title = {Three Author Paper},
  booktitle = {Proc. of Conf},
  year = {2021}
}
@misc{nodate,
  title = {No Year Note},
  author = {Doe, Jane}
}
@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The TeXbook},
  publisher = {Addison-Wesley},
  year = {1984}
}
`);

const num = (keys: string[]) => assignCitationNumbers(keys);

describe("parseCitationInner（[@…] 语法）", () => {
  it("单键 / @ 前缀 / 定位符", () => {
    expect(parseCitationInner("@smith2020")).toEqual({ keys: ["smith2020"], locator: "" });
    expect(parseCitationInner("smith2020")).toEqual({ keys: ["smith2020"], locator: "" });
    expect(parseCitationInner("@smith2020, p. 12")).toEqual({
      keys: ["smith2020"],
      locator: "p. 12",
    });
  });

  it("多键（; 与无空格逗号分隔）与尾随定位符", () => {
    expect(parseCitationInner("@k1; @k2")).toEqual({ keys: ["k1", "k2"], locator: "" });
    expect(parseCitationInner("@k1,@k2")).toEqual({ keys: ["k1", "k2"], locator: "" });
    expect(parseCitationInner("@k1; @k2, ch. 3")).toEqual({
      keys: ["k1", "k2"],
      locator: "ch. 3",
    });
  });

  it("空串 / 纯定位符 → null", () => {
    expect(parseCitationInner("")).toBeNull();
    expect(parseCitationInner("   ")).toBeNull();
  });
});

describe("作者形态", () => {
  it("短形态：1/2/3+ 作者", () => {
    const smith = entries.find((e) => e.key === "smith2020")!;
    const lee = entries.find((e) => e.key === "lee2021")!;
    const knuth = entries.find((e) => e.key === "knuth1984")!;
    expect(authorShort(smith)).toBe("Smith & Lee");
    expect(authorShort(lee)).toBe("Lee et al.");
    expect(authorShort(knuth)).toBe("Knuth");
  });

  it("author-year 文本与无年份回退 n.d.", () => {
    const nodate = entries.find((e) => e.key === "nodate")!;
    expect(authorYearText(nodate)).toBe("Doe, n.d.");
  });
});

describe("formatInlineCitation（两种样式）", () => {
  it("numeric：编号 + 定位符；未解析键保留键名", () => {
    const numbers = num(["smith2020", "lee2021"]);
    expect(
      formatInlineCitation(entries, ["smith2020"], "", "numeric", numbers)
    ).toBe("[1]");
    expect(
      formatInlineCitation(entries, ["smith2020", "lee2021"], "p. 12", "numeric", numbers)
    ).toBe("[1, 2, p. 12]");
    expect(
      formatInlineCitation(entries, ["ghost2099"], "", "numeric", numbers)
    ).toBe("[ghost2099]");
  });

  it("author-year：作者-年份 + 定位符；未解析键保留键名", () => {
    const m = new Map<string, number>();
    expect(formatInlineCitation(entries, ["smith2020"], "", "author-year", m)).toBe(
      "(Smith & Lee, 2020)"
    );
    expect(formatInlineCitation(entries, ["smith2020"], "p. 12", "author-year", m)).toBe(
      "(Smith & Lee, 2020, p. 12)"
    );
    expect(
      formatInlineCitation(entries, ["smith2020", "lee2021"], "", "author-year", m)
    ).toBe("(Smith & Lee, 2020; Lee et al., 2021)");
    expect(formatInlineCitation(entries, ["ghost2099"], "", "author-year", m)).toBe("(ghost2099)");
  });
});

describe("assignCitationNumbers（文档序编号）", () => {
  it("首现占号、重复不重编、大小写归一", () => {
    const numbers = assignCitationNumbers(["b", "a", "B", "a", "c"]);
    expect(numbers.get("b")).toBe(1);
    expect(numbers.get("a")).toBe(2);
    expect(numbers.get("c")).toBe(3);
    expect(numbers.size).toBe(3);
  });
});

describe("参考文献表", () => {
  it("formatReference：作者+年份+标题+出处（APA 简化）", () => {
    const smith = entries.find((e) => e.key === "smith2020")!;
    const text = formatReference(smith);
    expect(text).toContain("Smith, J., & Lee, K. (2020).");
    expect(text).toContain("A Study of Things.");
    expect(text).toContain("*Journal of Examples*, *12*(3), 45–67");
    expect(text).toContain("doi:10.1000/xyz123");
  });

  it("numeric：按引用出现序编号；未解析键不进表", () => {
    const keys = ["lee2021", "smith2020", "ghost", "smith2020"];
    const numeric = buildReferences(entries, keys, "numeric");
    expect(numeric.map((r) => r.number)).toEqual([1, 2]);
    expect(numeric[0].key).toBe("lee2021");
    expect(numeric[1].key).toBe("smith2020");
  });

  it("author-year 表按 family 字母序（Knuth < Lee < Smith）", () => {
    const keys = ["smith2020", "lee2021", "knuth1984"];
    const ay = buildReferences(entries, keys, "author-year");
    expect(ay.map((r) => r.key)).toEqual(["knuth1984", "lee2021", "smith2020"]);
    expect(ay.every((r) => r.number === null)).toBe(true);
  });
});

describe("isReferencesHeadingText（标记标题匹配）", () => {
  it("References / 参考文献 / 带冒号 / 大小写与 H2", () => {
    expect(isReferencesHeadingText("References")).toBe(true);
    expect(isReferencesHeadingText("  REFERENCES ")).toBe(true);
    expect(isReferencesHeadingText("参考文献")).toBe(true);
    expect(isReferencesHeadingText("参考文献：")).toBe(true);
    expect(isReferencesHeadingText("参考资料")).toBe(true);
    expect(isReferencesHeadingText("Reference list")).toBe(false);
    expect(isReferencesHeadingText("文献综述")).toBe(false);
  });
});

// BibEntry 形态断言（供 CI 抓手）。
void ({} as BibEntry);
