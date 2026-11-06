// PI2 铁律锚点（printIronRule）：**全仓 src/ 零 webview 打印调用字面量**。
//
// 演进：PR 轮允许「唯一例外」——打印模板里注入用户系统浏览器的自动打印
// 脚本（PRINT_AUTO_SCRIPT，运行于应用 webview 外）。PI2 把打印整体收回
// 应用内（自研对话框 + GDI 直打），外部通道连同该例外一并退役——本测试
// 随之升级为更强口径：window 与 print 的拼接调用字面量在全仓 **零命中**
// （连注释里的完整字面量都不允许，历史注释一律分写措辞）。
//
// 历史根因（为什么这条铁律存在）：wry#707 的 WebView2 打印限制 +
// RC-4 超大 DOM 走打印引擎的超线性崩溃（docs/export-overhaul-report.md）。
// EX 轮退役了应用内打印路径；PI2 的应用内打印是**另一条路**（自研 PDF
// 管线 + Rust GDI 直打），依然不碰 webview 打印设施。

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 拆开写防自陷（本文件自身不得命中扫描目标）。 */
const NEEDLE = ["window", "print"].join(".");

const SRC_ROOT = join(__dirname, "..");

interface Hit {
  file: string;
  index: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

async function scanNeedle(): Promise<Hit[]> {
  const hits: Hit[] = [];
  for await (const file of walk(SRC_ROOT)) {
    const text = await readFile(file, "utf8");
    let from = 0;
    for (;;) {
      const i = text.indexOf(NEEDLE, from);
      if (i < 0) break;
      hits.push({ file, index: i });
      from = i + NEEDLE.length;
    }
  }
  return hits;
}

describe("PI2 打印铁律：全仓零 webview 打印调用", () => {
  it(`${NEEDLE} 字面量在 src/ 全仓零命中`, async () => {
    const hits = await scanNeedle();
    expect(
      hits,
      `以下位置出现 ${NEEDLE} 字面量（webview 打印已退役且 PI2 不复活；` +
        `注释也请分写措辞）：\n${hits
          .map((h) => `${h.file} @${h.index}`)
          .join("\n")}`
    ).toEqual([]);
  });

  it("打印执行不经 openExternal（printJob 零外部通道引用）", async () => {
    const text = await readFile(join(SRC_ROOT, "lib", "printJob.ts"), "utf8");
    expect(text.includes("openExternal")).toBe(false);
  });
});
