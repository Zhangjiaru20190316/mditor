// BibTeX 解析器测试（模块 3）：覆盖 Zotero Better BibTeX 常见导出形态、
// 容错（坏条目跳过不中断）、@string 展开、人名解析与 200+ 条目规模验收。

import { describe, expect, it } from "vitest";
import { bibFieldText, findBibEntry, initialsOf, parseBibAuthors, parseBibtex } from "./bibtex";

const SAMPLE = `
% 注释行
@article{smith2020,
  author  = {Smith, John Alan and Lee, Kate},
  title   = {A {Study} of Things},
  journal = {Journal of Examples},
  year    = 2020,
  volume  = {12},
  number  = {3},
  pages   = {45--67},
  doi     = {10.1000/xyz123}
}

@inproceedings(lee2021,
  author = "Lee, Kate and others",
  title = "Conference Paper",
  booktitle = "Proc. of Conf",
  year = "2021"
)

@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The TeXbook},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@misc{note2022,
  title = {Untitled Note},
  year  = {2022}
}

@string{acm = {Association for Computing Machinery}}
@string{toc = {ACM Trans. on Computers}}
@article{ withString,
  author = {Doe, Jane},
  title = uses # " " # acm,
  journal = toc,
  year = {2019}
}

@comment{这是注释 @article{fake2020, title={Fake}}}

@phdthesis{yang2018,
  author = {Yang, Wei},
  title = {Deep Learning for Something},
  school = {Some University},
  year = {2018}
}
`;

describe("parseBibtex（基础解析）", () => {
  const { entries, errors } = parseBibtex(SAMPLE);

  it("解析全部条目（{} 与 () 定界、@string 展开、@comment 跳过）", () => {
    expect(errors).toEqual([]);
    const keys = entries.map((e) => e.key.toLowerCase());
    expect(keys).toEqual([
      "smith2020",
      "lee2021",
      "knuth1984",
      "note2022",
      "withstring",
      "yang2018",
    ]);
  });

  it("字段值与字段名归一（小写键、拼接 #、数字 bare 值）", () => {
    const e = findBibEntry(entries, "smith2020");
    expect(e).not.toBeNull();
    expect(e?.fields.author).toBe("Smith, John Alan and Lee, Kate");
    expect(e?.fields.year).toBe("2020");
    expect(e?.fields.volume).toBe("12");
    expect(e?.fields.pages).toBe("45--67");
    const ws = findBibEntry(entries, "withString");
    expect(ws?.fields.title).toBe("uses Association for Computing Machinery");
    expect(ws?.fields.journal).toBe("ACM Trans. on Computers");
  });

  it("citekey 大小写不敏感检索", () => {
    expect(findBibEntry(entries, "SMITH2020")?.type).toBe("article");
    expect(findBibEntry(entries, "nope")).toBeNull();
  });

  it("花括号保护的标题清洗", () => {
    const e = findBibEntry(entries, "smith2020");
    expect(bibFieldText(e!, "title")).toBe("A Study of Things");
  });
});

describe("parseBibtex（容错：坏条目跳过并告警）", () => {
  it("字段值缺失 → 记 error 并跳过，后续条目完好", () => {
    const src = `@article{good2020, title={Good}, year={2020}}

@article{bad1, author={X}, title= }

@article{after2021, title={After}, year={2021}}`;
    const { entries, errors } = parseBibtex(src);
    expect(entries.map((e) => e.key)).toEqual(["good2020", "after2021"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("bad1");
  });

  it("未闭合条目 → 跳到下一条目恢复", () => {
    const src = `@article{unclosed, title={No End
@article{next2022, title={Next}, year={2022}}`;
    const { entries } = parseBibtex(src);
    expect(entries.map((e) => e.key)).toEqual(["next2022"]);
  });

  it("孤立 @（邮箱）不产生条目", () => {
    const src = `联系 alice@example.com 勿解析。
@article{real2023, title={Real}, year={2023}}`;
    const { entries } = parseBibtex(src);
    expect(entries.map((e) => e.key)).toEqual(["real2023"]);
  });

  it("重复 citekey 后者覆盖前者", () => {
    const src = `@article{dup, title={Old}, year={2000}}
@article{dup, title={New}, year={2001}}`;
    const { entries } = parseBibtex(src);
    expect(entries.length).toBe(1);
    expect(entries[0].fields.title).toBe("New");
  });
});

describe("parseBibtex（规模验收：200+ 条目）", () => {
  it("合成 200 条 Zotero 风格条目全部解析、含 3 条坏条目不中断", () => {
    const parts: string[] = [];
    for (let i = 1; i <= 200; i++) {
      parts.push(
        `@article{zot${i},
  author = {Author${i}, First${i} and Coauthor${i}, Second},
  title = {Sample Article Number ${i}},
  journal = {Journal of Samples},
  year = {2000},
  volume = {${i}},
  pages = {${i}--${i + 10}},
  doi = {10.1000/zot${i}}
}`
      );
    }
    // 混入坏条目（模拟真实导出中的损坏行）。
    parts.splice(50, 0, "@article{brokenNoClose, title={oops");
    parts.splice(100, 0, "@article{brokenField, author = {A}, title ===}");
    parts.splice(150, 0, "@article{, title={no key}, year={2001}}");
    const { entries, errors } = parseBibtex(parts.join("\n\n"));
    expect(entries.length).toBe(200);
    expect(errors.length).toBe(3);
    expect(entries[199].key).toBe("zot200");
  });
});

describe("parseBibAuthors / initialsOf", () => {
  it("Family, Given 与 Given Family 两种形态", () => {
    const a = parseBibAuthors("Smith, John Alan and Lee, Kate");
    expect(a).toEqual([
      { family: "Smith", given: "John Alan" },
      { family: "Lee", given: "Kate" },
    ]);
    const b = parseBibAuthors("Kate Lee");
    expect(b).toEqual([{ family: "Lee", given: "Kate" }]);
  });

  it("others 占位与花括号保护（{de la Cruz}, Maria）", () => {
    const a = parseBibAuthors("Lee, Kate and others");
    expect(a.length).toBe(1);
    const b = parseBibAuthors("{de la Cruz}, Maria and Smith, Bob");
    expect(b[0]).toEqual({ family: "de la Cruz", given: "Maria" });
  });

  it("首字母缩写", () => {
    expect(initialsOf("John Alan")).toBe("J. A.");
    expect(initialsOf("")).toBe("");
  });
});
