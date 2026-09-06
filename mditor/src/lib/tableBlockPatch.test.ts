// 表格节点视图补丁锚点测试（MD-1011 残余根修的守卫）。
//
// 根因：@milkdown/components 的 TableNodeView.update() 在新旧节点完全相同
// （sameMarkup && content.eq）时返回 false——按 ProseMirror 节点视图契约，
// false = 「此视图无法处理该节点，销毁重建」。于是内容未变的整篇重载
// （标签切回 / watcher 回声 / 程序化写回）会把每个表格视图（内部各挂一个
// Vue app）全部拆掉重建：生产日志 2026-09-01/02 的 MD-1011 批次
// （-197/+197 等，移除样本指纹 <div.milkdown-table-block ×0>）与下游
// MD-1002/MD-1001（content-visibility remembered size 随旧元素消亡丢失）、
// MD-1003 长任务皆源于此。修复见 patches/@milkdown+components+7.22.1.patch
// 的 table-block hunk（同文件 code-block hunk 是另一处独立修复）。
//
// 本测试是源锚点（source anchor）而非行为测试：TableNodeView 构造需要真实
// DOM + Vue 挂载，收益不成比例；而「补丁是否在位」恰好是 npm ci 漏跑
// postinstall / milkdown 升级后 patch-package 冲突静默丢弃这两个最现实的
// 回归面。锚点失配时先重打补丁（改 node_modules 后 npx patch-package
// @milkdown/components），不要删测试。
//
// 注：tsc 的 lib 不含 node 类型（测试约定纯逻辑），node:fs 走运行时动态
// 导入 + @ts-expect-error；若未来引入 @types/node 使其失效，删注释即可。

import { describe, expect, it } from "vitest";

// @ts-expect-error node:fs 仅存在于 vitest 的 node 运行时
const { readFileSync } = await import("node:fs");

/** 截取 TableNodeView.update() 方法体（class 内首个 update(node) { … }）。 */
function updateMethodSource(src: string): string {
  const start = src.indexOf("update(node) {");
  expect(start, "TableNodeView.update(node) 存在").toBeGreaterThan(0);
  let depth = 0;
  for (let i = start + "update(node) {".length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("update(node) 方法体未闭合");
}

describe("table-block node view patch (MD-1011 residual fix)", async () => {
  // 相对本测试文件：src/lib/ → 仓库根 → node_modules。
  const fileUrl = new URL(
    "../../node_modules/@milkdown/components/lib/table-block/index.js",
    import.meta.url
  );
  const src = readFileSync(fileUrl, "utf8");

  it("补丁在位：带 mditor fix 标记（npm ci 后 postinstall 必须重放补丁）", () => {
    expect(src).toContain("mditor fix");
  });

  it("内容相同的分支返回 true（保留视图，不销毁重建）", () => {
    const body = updateMethodSource(src);
    const identical = body.indexOf(
      "node.sameMarkup(this.node) && node.content.eq(this.node.content)"
    );
    expect(identical, "sameMarkup && content.eq 判定存在").toBeGreaterThan(0);
    // 该判定后的第一个 return 必须是 true（旧版是 false = 触发整视图重建）。
    const nextReturn = body.indexOf("return", identical);
    expect(nextReturn).toBeGreaterThan(0);
    expect(body.slice(nextReturn, nextReturn + 20)).toMatch(/^\s*return\s+true/);
  });

  it("类型不同的早退分支仍返回 false（ProseMirror 契约保留）", () => {
    const body = updateMethodSource(src);
    expect(body).toContain("if (node.type !== this.node.type) return false;");
  });
});
