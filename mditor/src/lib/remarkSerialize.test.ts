import { describe, expect, it } from "vitest";
import { unified } from "unified";
import type { Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import { remarkMark } from "./remarkMark";
import { remarkTextColor } from "./remarkTextColor";

// 序列化往返回归测试（v3.9.7 修复的锚点）。
//
// 背景：Milkdown 的保存路径是 getMarkdown() → SerializerState.build() 产出
// mdast 树（`mark` / `textColor` 节点即此处诞生）→ remark.stringify(tree)。
// remark-stringify v11 的编译器只读 `data.toMarkdownExtensions` 键；旧版把
// 序列化 handler 注册到没人消费的 `data.toMarkdown` 死键，导致 `mark` /
// `textColor` 节点序列化时抛 "Cannot handle unknown node"，编辑器整体
// getMarkdown() 失败回退旧缓存——「高光/颜色存不下来」的根因。
//
// 这里的处理器 1:1 复刻 @milkdown/core 的 remarkCtx 基座
// （unified().use(remarkParse).use(remarkStringify) + $remark 注册的插件），
// 用例直接锚定注册键修复后的行为：任何把注册路径改回去/升级 remark-stringify
// 改键名的改动都会在这里先红。

interface N {
  type?: string;
  value?: string;
  color?: string;
  children?: N[];
  [k: string]: unknown;
}

/** 与 Milkdown remarkCtx 同构的处理器：parse + stringify 基座、gfm 预设、
 *  再经 $remark 挂上本应用的两个自定义插件（注册路径与 useMilkdown 一致）。 */
function buildMilkdownLikeProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkStringify)
    .use(remarkGfm)
    .use(remarkMark as unknown as Plugin)
    .use(remarkTextColor as unknown as Plugin);
}

/** 模拟 Milkdown SerializerState.build() 对「段落：前缀 + 高亮 + 颜色字 +
 *  后缀」文档产出的 mdast（highlightMark.ts 的 withMark(mark,"mark") 与
 *  textColorMark.ts 的 withMark(mark,"textColor",…,{color}) 的产物形状）。 */
function mixedDocTree(): N {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: "前缀 " },
          { type: "mark", children: [{ type: "text", value: "高亮片段" }] },
          { type: "text", value: " 和 " },
          {
            type: "textColor",
            color: "#e11d48",
            children: [{ type: "text", value: "红字" }],
          },
          { type: "text", value: " 后缀" },
        ],
      },
    ],
  };
}

describe("remarkSerialize（Milkdown 保存路径：mdast → markdown）", () => {
  const proc = buildMilkdownLikeProcessor();

  it("mark 节点序列化为 ==高亮==（不再抛 unknown node）", () => {
    // 旧 bug 在这一步直接抛 "Cannot handle unknown node 'mark'"。
    const out = proc.stringify(mixedDocTree() as never);
    expect(out).toContain("==高亮片段==");
  });

  it("textColor 节点序列化为 <span style=\"color:…\">…</span>", () => {
    const out = proc.stringify(mixedDocTree() as never);
    expect(out).toContain('<span style="color:#e11d48">红字</span>');
  });

  it("混排文档：mark 与 textColor 与普通文本共存，前后文本不丢失", () => {
    const out = proc.stringify(mixedDocTree() as never);
    expect(out).toContain("前缀 ");
    expect(out).toContain(" 和 ");
    expect(out).toContain(" 后缀");
  });

  it("完整往返：markdown →(parse) mdast →(stringify) markdown，标记保形", () => {
    const src = '前缀 ==高亮片段== 和 <span style="color:#e11d48">红字</span> 后缀';
    const tree = proc.runSync(proc.parse(src), src);
    const out = proc.stringify(tree as never);
    // 往返语义等价：高亮与颜色标记都必须存活（空格规范化允许差异）。
    expect(out).toContain("==高亮片段==");
    expect(out).toContain('<span style="color:#e11d48">红字</span>');
  });

  it("嵌套结构：加粗内部的高亮 + 颜色（mark 包 strong / strong 包 textColor）", () => {
    const tree: N = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "strong",
              children: [
                { type: "text", value: "粗体内 " },
                { type: "mark", children: [{ type: "text", value: "粗高亮" }] },
              ],
            },
            {
              type: "textColor",
              color: "red",
              children: [
                { type: "strong", children: [{ type: "text", value: "红粗" }] },
              ],
            },
          ],
        },
      ],
    };
    const out = proc.stringify(tree as never);
    expect(out).toContain("**粗体内 ==粗高亮==**");
    expect(out).toContain('<span style="color:red">**红粗**</span>');
  });

  it("处理器复用：多次 stringify 互不串扰（编辑器常驻 remarkCtx 的前提）", () => {
    const a = proc.stringify(mixedDocTree() as never);
    const b = proc.stringify(mixedDocTree() as never);
    expect(a).toBe(b);
    expect(a).toContain("==高亮片段==");
  });
});
