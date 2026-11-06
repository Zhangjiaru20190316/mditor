// 同步过滤规则单测（v5.3）：扩展名白名单参数化（默认行为不变 + custom
// 替换式覆盖）、每根排除规则（目录前缀 + glob-lite 通配）。纯函数，无桩。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNCABLE_EXTS,
  isExcludedRelPath,
  isSyncableRelPath,
} from "./ignore";

describe("isSyncableRelPath：扩展名白名单参数化（v5.3）", () => {
  it("缺省参数 = 内置默认白名单，既有行为完全不变", () => {
    expect(isSyncableRelPath("a.md")).toBe(true);
    expect(isSyncableRelPath("sub/b.HTML")).toBe(true);
    expect(isSyncableRelPath("c.pdf")).toBe(true);
    expect(isSyncableRelPath("d.docx")).toBe(true);
    expect(isSyncableRelPath("e.png")).toBe(false);
    expect(isSyncableRelPath("f.txt")).toBe(false);
    // 无扩展名 / 点开头（.md 视为隐藏名）/ 尾点。
    expect(isSyncableRelPath("noext")).toBe(false);
    expect(isSyncableRelPath(".md")).toBe(false);
    expect(isSyncableRelPath("trailing.")).toBe(false);
  });

  it("custom 模式传完整白名单（替换式）：列表内同步、列表外忽略", () => {
    const exts = new Set(["png", "md"]);
    expect(isSyncableRelPath("a.png", exts)).toBe(true);
    expect(isSyncableRelPath("b.md", exts)).toBe(true);
    expect(isSyncableRelPath("c.pdf", exts)).toBe(false);
    expect(isSyncableRelPath("d.html", exts)).toBe(false);
  });

  it("大小写不敏感；DEFAULT_SYNCABLE_EXTS 即内置四类", () => {
    expect(isSyncableRelPath("A.PNG", new Set(["png"]))).toBe(true);
    expect(DEFAULT_SYNCABLE_EXTS.has("md")).toBe(true);
    expect(DEFAULT_SYNCABLE_EXTS.has("html")).toBe(true);
    expect(DEFAULT_SYNCABLE_EXTS.has("pdf")).toBe(true);
    expect(DEFAULT_SYNCABLE_EXTS.has("docx")).toBe(true);
    expect(DEFAULT_SYNCABLE_EXTS.size).toBe(4);
  });
});

describe("isExcludedRelPath：目录前缀排除（v5.3）", () => {
  const rules = { excludedDirs: ["assets", "notes/drafts"] };

  it("命中目录本身与其下任意深度内容", () => {
    expect(isExcludedRelPath("assets", rules)).toBe(true);
    expect(isExcludedRelPath("assets/a.md", rules)).toBe(true);
    expect(isExcludedRelPath("assets/sub/deep/b.md", rules)).toBe(true);
    expect(isExcludedRelPath("notes/drafts/c.md", rules)).toBe(true);
  });

  it("未命中目录不受影响；同名前缀目录不误伤", () => {
    expect(isExcludedRelPath("notes/ok.md", rules)).toBe(false);
    expect(isExcludedRelPath("assets2/x.md", rules)).toBe(false);
    expect(isExcludedRelPath("notes/drafts-old/x.md", rules)).toBe(false);
    expect(isExcludedRelPath("root.md", rules)).toBe(false);
  });

  it("大小写不敏感（Windows 盘手敲规则常见大小写差异）", () => {
    expect(isExcludedRelPath("Assets/X.md", rules)).toBe(true);
    expect(isExcludedRelPath("NOTES/drafts/y.md", rules)).toBe(true);
  });

  it("undefined / 空规则 = 全不排除", () => {
    expect(isExcludedRelPath("assets/a.md", undefined)).toBe(false);
    expect(isExcludedRelPath("assets/a.md", {})).toBe(false);
    expect(isExcludedRelPath("assets/a.md", { excludedDirs: [] })).toBe(false);
  });
});

describe("isExcludedRelPath：通配排除规则（glob-lite）", () => {
  it("`*` 段内通配（不含 /）", () => {
    const rules = { excludePatterns: ["*.tmp"] };
    expect(isExcludedRelPath("a.tmp", rules)).toBe(true);
    expect(isExcludedRelPath("sub/b.tmp", rules)).toBe(true); // 裸段匹配任意层级
    expect(isExcludedRelPath("a.md", rules)).toBe(false);
  });

  it("`**` 跨段通配（零或多段）；单段 `*` 不跨段", () => {
    const rules = { excludePatterns: ["temp/**"] };
    expect(isExcludedRelPath("temp/a.md", rules)).toBe(true);
    expect(isExcludedRelPath("temp/x/y.md", rules)).toBe(true);
    expect(isExcludedRelPath("temperature/a.md", rules)).toBe(false);
    const single = { excludePatterns: ["a/*/b.md"] };
    expect(isExcludedRelPath("a/x/b.md", single)).toBe(true);
    expect(isExcludedRelPath("a/x/y/b.md", single)).toBe(false);
  });

  it("裸名（字面模式）按目录语义：命中任意层级同名目录与其内容", () => {
    const rules = { excludePatterns: ["node_modules"] };
    expect(isExcludedRelPath("node_modules", rules)).toBe(true);
    expect(isExcludedRelPath("node_modules/a.md", rules)).toBe(true);
    expect(isExcludedRelPath("proj/node_modules/a.md", rules)).toBe(true);
    expect(isExcludedRelPath("proj/node_modules", rules)).toBe(true);
    expect(isExcludedRelPath("node_modules-extra/a.md", rules)).toBe(false);
  });

  it("含路径段的多段模式按整段序列匹配", () => {
    const rules = { excludePatterns: ["notes/draft*.md"] };
    expect(isExcludedRelPath("notes/draft1.md", rules)).toBe(true);
    expect(isExcludedRelPath("notes/draft-final.md", rules)).toBe(true);
    expect(isExcludedRelPath("other/draft1.md", rules)).toBe(false);
  });

  it("尾随 / 与大小写差异归一", () => {
    const rules = { excludePatterns: ["Temp/"] };
    expect(isExcludedRelPath("temp/a.md", rules)).toBe(true);
  });

  it("目录前缀与通配任一命中即排除", () => {
    const rules = { excludedDirs: ["assets"], excludePatterns: ["*.log"] };
    expect(isExcludedRelPath("assets/a.md", rules)).toBe(true);
    expect(isExcludedRelPath("debug.log", rules)).toBe(true);
    expect(isExcludedRelPath("notes/a.md", rules)).toBe(false);
  });
});
