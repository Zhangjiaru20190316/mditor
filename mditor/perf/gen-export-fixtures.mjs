// EX 轮阶段一：生成导出验收 fixture（多图文档 + 减配触发变体）。
// 产物落在 perf/fixtures/（整目录 gitignore，本地化惯例），本脚本本身提交
// 以保证可重建。依赖系统 ffmpeg（生成位图/动图）——不可用时跳过并提示。
//
//   node perf/gen-export-fixtures.mjs
//
// 生成内容：
//   assets/normal-red.png    小图对照组（应被内联）
//   assets/big-noise.png     >10MB 噪声图（超 INLINE_IMG_MAX_BYTES，静默降级靶）
//   assets/anim.gif          两帧动图（E-1 靶：动图解码/渲染）
//   assets/fake.png          伪 PNG（魔数嗅探失败靶）
//   多图导出压测副本.md       E-1/E-2 靶场文档（本地大图/远程图/动图/宽表/长行）
//   无穷级数_密度档压测副本_减配触发.md  密度档 + 垫层 >3000 行（RC-5 靶场）
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const assets = join(root, "assets");
mkdirSync(assets, { recursive: true });

function ff(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "pipe" });
}

function haveFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

if (!haveFfmpeg()) {
  console.error("系统无 ffmpeg，跳过位图生成（请手工补齐 assets/ 下四张图）");
} else {
  // 对照组小图：纯色 320×160（压缩后几 KB）。
  if (!existsSync(join(assets, "normal-red.png")))
    ff(["-f", "lavfi", "-i", "color=c=0xcc3344:s=320x160", "-frames:v", "1", join(assets, "normal-red.png")]);
  // >10MB 噪声图：RGB 噪声几乎不可压缩，2600×1900×3 ≈ 14.8MB 原始 → PNG 仍 >10MB。
  if (!existsSync(join(assets, "big-noise.png")))
    ff(["-f", "lavfi", "-i", "nullsrc=s=2600x1900,geq=random(1)*255:random(2)*255:random(3)*255", "-frames:v", "1", join(assets, "big-noise.png")]);
  // 两帧动图（r=2, d=1）。
  if (!existsSync(join(assets, "anim.gif")))
    ff(["-f", "lavfi", "-i", "testsrc=duration=1:size=200x100:rate=2", "-loop", "0", join(assets, "anim.gif")]);
  // 伪 PNG：扩展名 .png、内容为随机字节（魔数嗅探必败）。
  if (!existsSync(join(assets, "fake.png"))) {
    const buf = Buffer.alloc(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
    buf[0] = 0x4e; buf[1] = 0x4f; buf[2] = 0x54; // 故意不是 PNG 魔数
    writeFileSync(join(assets, "fake.png"), buf);
  }
}

// ---- 多图文档（E-1/E-2 靶场）-------------------------------------------------
const multiImg = `---
title: 多图导出压测
date: 2026-10-10T09:00:00Z
---

# 多图导出压测文档

本文档为 EX 轮 E-1（图片缺失/裂图）与 E-2（边缘裁切）复现靶场：五种图片
引用形态 + 宽表格 + 超长行 + 公式，覆盖导出完整性的全部已知攻击面。

## 图1 正常小图（对照组，预算内应内联）

![对照组：纯色小图](assets/normal-red.png)

## 图2 本地大图 >10MB（超单图预算，静默降级靶）

![超预算大图：2600×1900 噪声](assets/big-noise.png)

## 图3 动图（GIF 两帧）

![动图](assets/anim.gif)

## 图4 伪 PNG（魔数嗅探失败靶）

![伪图](assets/fake.png)

## 图5 远程图（永不内联，网络依赖靶）

![远程图 picsum](https://picsum.photos/seed/mditor-ex/640/320)

## 公式（行内 + 块级）

行内公式对照：$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$，以及 $e^{i\\pi}+1=0$。

$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$

## 宽表格（E-2 靶：列宽逼近 820px 内容宽）

| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 数据甲0001 | 数据乙0002 | 数据丙0003 | 数据丁0004 | 数据戊0005 | 数据己0006 | 数据庚0007 | 数据辛0008 |
| 长单元格内容AAAA | 长单元格内容BBBB | 长单元格内容CCCC | 长单元格内容DDDD | 长单元格内容EEEE | 长单元格内容FFFF | 长单元格内容GGGG | 长单元格内容HHHH |

## 超长不可断行（E-2 靶：右缘溢出）

<https://example.com/very/long/path/that/should/not/wrap/at/all/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb>

## 代码块（着色与等宽对照）

\`\`\`ts
export async function exportPdf(ctx: ExportContext): Promise<void> {
  const html = await inlineLocalImages(sanitizeExportHtml(ctx.html), ctx.docPath);
  await printHtml(wrapHtml(html, ctx.css, title, currentTheme()));
}
\`\`\`

## 中文段落

导出完整性压测：这是一段用于验证中文文本在导出产物中完整性的普通段落。
排版应与编辑器一致，首行缩进与行距由主题 CSS 决定。段落足够长以覆盖多行
换行场景，从而在分页时验证行级断点与孤儿寡妇控制。
`;
writeFileSync(join(root, "多图导出压测副本.md"), multiImg);

// ---- 减配触发变体（RC-5 靶场：密度档原文 + 垫层 >3000 行）--------------------
const src = join(root, "无穷级数_密度档压测副本.md");
const dst = join(root, "无穷级数_密度档压测副本_减配触发.md");
if (existsSync(src) && !existsSync(dst)) {
  const base = readFileSync(src, "utf8");
  const pad = ["", "<!-- 减配档触发垫层：纯文本段落，无公式无图片，仅为把行数推过 BIG_DOC_LINES=3000，使总开关 ON 时进入减配档。 -->"];
  for (let i = 1; i <= 900; i++) pad.push(`垫层段落第 ${i} 行。这是用于触发减配档的填充文本，不参与公式完整性统计。`);
  writeFileSync(dst, base + "\n" + pad.join("\n") + "\n", "utf8");
}

console.log("fixtures ready:", existsSync(join(assets, "big-noise.png")) ? "assets ok" : "assets MISSING（ffmpeg 不可用）");
console.log("多图导出压测副本.md:", existsSync(join(root, "多图导出压测副本.md")) ? "ok" : "MISSING");
console.log("减配触发变体:", existsSync(dst) ? "ok" : "MISSING");
