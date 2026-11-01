// 字体预设体系守卫（内置字体轮）。
//
// 背景：设置面板「字体预设/代码字体预设」扩充为分组预设（types.ts FontPreset
// 新增 group/sample/bundled），其中 bundled 预设靠应用自带字体真实供字——
// 两条路线：① webfont npm 包（main.tsx import 的切片 css，family 名在各包
// css 的 @font-face 里）；② src/styles/fonts.css 手动注册（public/assets/fonts）。
// family 名与预设栈首字体一旦失配（改名/拼错），预设会静默回退系统字体、
// 「内置」徽标变谎言——本文件把对应关系钉死。默认设置锚定 DEFAULT_SETTINGS
// 的 fontPreset/monoFontPreset 必须能查到对应预设（回显依赖）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, FONT_PRESETS, MONO_FONT_PRESETS } from "../defaults";

/** 字体栈里第一个带引号的 family 名（内置供字按它命中 @font-face）。 */
function firstFamily(stack: string): string | null {
  const m = stack.match(/"([^"]+)"/);
  return m ? m[1] : null;
}

/** 从 css 文本提取所有 @font-face 注册的 family 名（剥注释后按声明抓取）。 */
function fontFaceFamilies(css: string): Set<string> {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const m of body.matchAll(/@font-face\s*\{[^}]*font-family:\s*["']([^"']+)["']/g)) {
    names.add(m[1]);
  }
  return names;
}

/** main.tsx 实际 import 的 webfont 包 css（路径硬编码对齐，防 import 被无声改走）。 */
const WEBFONT_CSS_PATHS = [
  "lxgw-wenkai-lite-webfont/lxgwwenkailite-regular.css",
  "@fontsource/maple-mono/400.css",
  "@fontsource/zcool-qingke-huangyou/400.css",
  "@fontsource/ma-shan-zheng/400.css",
];

const bundledFamilies = new Set<string>([
  ...fontFaceFamilies(readFileSync(new URL("../../src/styles/fonts.css", import.meta.url), "utf8")),
  ...WEBFONT_CSS_PATHS.flatMap((p) => [
    ...fontFaceFamilies(readFileSync(new URL(`../../node_modules/${p}`, import.meta.url), "utf8")),
  ]),
]);

describe("字体预设数据完整性（FONT_PRESETS / MONO_FONT_PRESETS）", () => {
  it("id 唯一且与默认设置的 fontPreset / monoFontPreset 可对上", () => {
    const proseIds = FONT_PRESETS.map((p) => p.id);
    const monoIds = MONO_FONT_PRESETS.map((p) => p.id);
    expect(new Set(proseIds).size).toBe(proseIds.length);
    expect(new Set(monoIds).size).toBe(monoIds.length);
    expect(proseIds).toContain(DEFAULT_SETTINGS.fontPreset);
    expect(monoIds).toContain(DEFAULT_SETTINGS.monoFontPreset);
  });

  it("每条预设 name / stack / group 非空，栈首 family 与「内置」声明一致", () => {
    for (const p of [...FONT_PRESETS, ...MONO_FONT_PRESETS]) {
      expect(p.name.trim(), `${p.id}: name 非空`).not.toBe("");
      expect(p.stack.trim(), `${p.id}: stack 非空`).not.toBe("");
      expect(p.group && p.group.trim(), `${p.id}: group 非空`).toBeTruthy();
      if (p.bundled) {
        const fam = firstFamily(p.stack);
        expect(fam, `${p.id}: 栈首应为带引号的内置 family`).not.toBeNull();
        expect(bundledFamilies.has(fam!), `${p.id}: "${fam}" 未在 fonts.css 或 webfont 包 css 中注册`).toBe(true);
      }
    }
  });

  it("内置字体清单：五款正文 + 一款代码，且分组齐备", () => {
    const bundledProse = FONT_PRESETS.filter((p) => p.bundled).map((p) => p.id);
    const bundledMono = MONO_FONT_PRESETS.filter((p) => p.bundled).map((p) => p.id);
    expect(bundledProse).toEqual(["sans", "wenkai", "mashanzheng", "smiley", "huangyou"]);
    expect(bundledMono).toEqual(["maple"]);
  });
});

describe("fonts.css / webfont 包 css 注册面", () => {
  it("fonts.css 手动注册 Noto Sans SC（复用 PDF 导出资产）与 Smiley Sans", () => {
    expect(bundledFamilies.has("Noto Sans SC")).toBe(true);
    expect(bundledFamilies.has("Smiley Sans")).toBe(true);
  });

  it("webfont 包 css 均含 @font-face 声明（防包升级移除切片 css 后静默失配）", () => {
    for (const p of WEBFONT_CSS_PATHS) {
      const css = readFileSync(new URL(`../../node_modules/${p}`, import.meta.url), "utf8");
      expect(fontFaceFamilies(css).size, `${p} 应含 @font-face`).toBeGreaterThan(0);
    }
  });
});
