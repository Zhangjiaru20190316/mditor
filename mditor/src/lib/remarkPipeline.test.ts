import { describe, expect, it } from "vitest";
import {
  buildEditorParseProcessor,
  expectedPluginCount,
  parseMarkdownTree,
} from "./remarkPipeline";

// Worker 侧 remark 管线与 Milkdown 编辑器解析行为的一致性测试：这些用例锚定
// 「同插件集 → 同 mdast」契约的具体面（mark / gfm / 脚注 / 行内链接归一 /
// <br> 清理 / 颜色 span / math 块化 / 大文档无 math）。任何插件升级导致的
// 行为漂移都应在这里先红，而不是在富文本渲染里被用户发现。

interface N {
  type?: string;
  value?: string;
  lang?: string;
  color?: string;
  children?: N[];
  [k: string]: unknown;
}

const proc = buildEditorParseProcessor(true);
const procNoMath = buildEditorParseProcessor(false);

function types(node: N): string[] {
  const out: string[] = [];
  const walk = (n: N) => {
    out.push(n.type ?? "?");
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

function findType(node: N, type: string): N | null {
  if (node.type === type) return node;
  for (const c of node.children ?? []) {
    const hit = findType(c, type);
    if (hit) return hit;
  }
  return null;
}

describe("remarkPipeline（worker 侧解析一致性）", () => {
  it("基础 commonmark：标题/段落/加粗结构", () => {
    const tree = parseMarkdownTree(proc, "# 标题\n\n**粗体**文本");
    expect(tree.type).toBe("root");
    expect(tree.children?.[0]?.type).toBe("heading");
    expect(types(tree)).toContain("strong");
  });

  it("==高亮== 语法 → mark 节点（本应用自定义 remarkMark）", () => {
    const tree = parseMarkdownTree(proc, "前缀 ==高亮片段== 后缀");
    const mark = findType(tree, "mark");
    expect(mark).not.toBeNull();
    expect(mark?.children?.[0]?.value).toBe("高亮片段");
  });

  it("颜色 span → textColor 节点（本应用自定义 remarkTextColor）", () => {
    const tree = parseMarkdownTree(
      proc,
      '红<span style="color: red">字</span>尾'
    );
    const color = findType(tree, "textColor");
    expect(color).not.toBeNull();
    expect(color?.color).toBe("red");
    expect(color?.children?.[0]?.value).toBe("字");
  });

  it("gfm：表格 / 删除线 / 任务列表 / 脚注", () => {
    const tree = parseMarkdownTree(
      proc,
      "~~删~~\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 完成\n\n引文[^1]\n\n[^1]: 定义"
    );
    const t = types(tree);
    expect(t).toContain("delete");
    expect(t).toContain("table");
    expect(t).toContain("listItem");
    expect(t).toContain("footnoteReference");
    expect(t).toContain("footnoteDefinition");
  });

  it("引用式链接被 remark-inline-links 归一为 link 节点", () => {
    const tree = parseMarkdownTree(proc, "[文字][k]\n\n[k]: https://x.example");
    expect(findType(tree, "link")).not.toBeNull();
    expect(findType(tree, "linkReference")).toBeNull();
  });

  it("段落内 <br> html 节点被清理（preserve-empty-line 复刻）", () => {
    const tree = parseMarkdownTree(proc, "第一行<br>第二行");
    expect(findType(tree, "html")).toBeNull();
    // <br> 分隔的两个文本仍在（Milkdown 用 hardbreak 语义承接）。
    expect(types(tree)).toContain("text");
  });

  it("withMath：$$ 块 → lang=LaTeX 的 code 节点（crepe mathBlock 复刻）", () => {
    const tree = parseMarkdownTree(proc, "$$\nE=mc^2\n$$");
    expect(findType(tree, "math")).toBeNull();
    const code = findType(tree, "code");
    expect(code?.lang).toBe("LaTeX");
    expect(code?.value).toBe("E=mc^2");
  });

  it("withMath=false（大文档档位）：$$ 是普通文本，不产生 math 节点", () => {
    const tree = parseMarkdownTree(procNoMath, "$$\nE=mc^2\n$$");
    const t = types(tree);
    expect(t).not.toContain("math");
    expect(t).not.toContain("inlineMath");
  });

  it("处理器可复用（多次解析互不串扰——worker 常驻的前提）", () => {
    const a = parseMarkdownTree(proc, "# A");
    const b = parseMarkdownTree(proc, "# B");
    expect((a.children?.[0] as N)?.children?.[0]?.value).toBe("A");
    expect((b.children?.[0] as N)?.children?.[0]?.value).toBe("B");
  });

  it("哨兵常量：小文档 7 个 / 大文档（latex 关）5 个 remark 插件", () => {
    expect(expectedPluginCount(true)).toBe(7);
    expect(expectedPluginCount(false)).toBe(5);
  });
});
