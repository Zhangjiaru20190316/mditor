// 设置归一与切片单测（Q4「types 必是类型」拆分：normalizeSyncSettings /
// pickEditorSettings 自 src/types.ts 迁往 src/settingsNormalize.ts，测试随
// 模块走并扩充）。
//
// normalizeSyncSettings 语义（v4.12 云同步设置的幂等归一，store 的
// migrateSettings 每次加载都会跑）：缺失/类型错误字段回填默认值、prefix
// 规范化（去空白、去前导 /、非空补尾随 /）、非法 interval 归 10、非法
// provider 归 custom——不抛错、不拒绝，恒返回一份完整合法的 SyncSettings，
// 且对自身输出幂等。
// pickEditorSettings 语义（P10）：从完整 Settings 提取 Editor（含
// useMilkdown）消费的 13 字段窄切片，字段原样直传、不克隆不变换。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults";
import { normalizeSyncSettings, pickEditorSettings } from "./settingsNormalize";
import type { Settings } from "./types";

describe("normalizeSyncSettings（v4.12 云同步设置幂等归一）", () => {
  it("undefined / 非对象输入补全默认值", () => {
    const out = normalizeSyncSettings(undefined);
    expect(out.enabled).toBe(false);
    expect(out.provider).toBe("custom");
    expect(out.prefix).toBe("mditor/");
    expect(out.autoSyncIntervalMin).toBe(10);
  });

  it("prefix 规范化：去前导 /、补尾随 /、空串保留", () => {
    expect(normalizeSyncSettings({ prefix: "/docs" }).prefix).toBe("docs/");
    expect(normalizeSyncSettings({ prefix: "docs" }).prefix).toBe("docs/");
    expect(normalizeSyncSettings({ prefix: "docs/" }).prefix).toBe("docs/");
    expect(normalizeSyncSettings({ prefix: "  " }).prefix).toBe("");
  });

  it("非法 interval 归 10；0（关闭定时）与正常值保留", () => {
    expect(normalizeSyncSettings({ autoSyncIntervalMin: -5 }).autoSyncIntervalMin).toBe(10);
    expect(normalizeSyncSettings({ autoSyncIntervalMin: "abc" }).autoSyncIntervalMin).toBe(10);
    expect(normalizeSyncSettings({ autoSyncIntervalMin: 0 }).autoSyncIntervalMin).toBe(0);
    expect(normalizeSyncSettings({ autoSyncIntervalMin: 30 }).autoSyncIntervalMin).toBe(30);
  });

  it("非法 provider 归 custom；已配置字段原样保留（幂等）", () => {
    expect(normalizeSyncSettings({ provider: "oss-xxx" }).provider).toBe("custom");
    const once = normalizeSyncSettings({
      enabled: true,
      bucket: "my-bucket",
      accessKeyId: "AK",
      pathStyle: true,
    });
    expect(once.enabled).toBe(true);
    expect(once.bucket).toBe("my-bucket");
    expect(once.pathStyle).toBe(true);
    // 幂等：归一结果再归一不变。
    expect(normalizeSyncSettings(once)).toEqual(once);
  });

  // ↓ Q4 新增锁定（迁移前先对旧实现跑绿，再随模块搬家）。

  it("字符串 / 数字 / null 等非对象输入同样回退全默认", () => {
    const fallback = normalizeSyncSettings(undefined);
    expect(normalizeSyncSettings("boom")).toEqual(fallback);
    expect(normalizeSyncSettings(42)).toEqual(fallback);
    expect(normalizeSyncSettings(null)).toEqual(fallback);
  });

  it("字段类型错误回退默认：数字 bucket、字符串 enabled、数字 prefix、布尔 endpoint", () => {
    const out = normalizeSyncSettings({
      bucket: 123,
      enabled: "yes",
      prefix: 42,
      endpoint: true,
    });
    expect(out.bucket).toBe("");
    expect(out.enabled).toBe(false);
    expect(out.prefix).toBe("mditor/");
    expect(out.endpoint).toBe("");
  });

  it("interval 小数向下取整（Math.floor）；Infinity / NaN 归 10", () => {
    expect(normalizeSyncSettings({ autoSyncIntervalMin: 3.9 }).autoSyncIntervalMin).toBe(3);
    expect(
      normalizeSyncSettings({ autoSyncIntervalMin: Infinity }).autoSyncIntervalMin
    ).toBe(10);
    expect(normalizeSyncSettings({ autoSyncIntervalMin: NaN }).autoSyncIntervalMin).toBe(10);
  });
});

describe("pickEditorSettings（P10 Editor 窄切片）", () => {
  it("提取 EditorSettings 全部 13 个字段，覆盖值与未覆盖默认值都原样直传", () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      autosaveIntervalMs: 5_000,
      memoryGuardThresholdMb: 1024,
      typewriterMode: true,
      fontFamily: "Custom Serif",
      monoFontFamily: "Custom Mono",
      fontSize: 18.5,
      lineHeight: 1.9,
      paragraphSpacing: 24,
      mathMacros: '{"\\RR": "\\mathbb{R}"}',
      bigDocPerformance: true,
      bigDocViewport: true,
    };
    expect(pickEditorSettings(s)).toEqual({
      autosaveIntervalMs: 5_000,
      memoryGuard: DEFAULT_SETTINGS.memoryGuard,
      memoryGuardThresholdMb: 1024,
      spellcheck: DEFAULT_SETTINGS.spellcheck,
      typewriterMode: true,
      fontFamily: "Custom Serif",
      monoFontFamily: "Custom Mono",
      fontSize: 18.5,
      lineHeight: 1.9,
      paragraphSpacing: 24,
      mathMacros: '{"\\RR": "\\mathbb{R}"}',
      bigDocPerformance: true,
      bigDocViewport: true,
    });
  });

  it("切片恰好 13 键：不含 theme / 侧栏宽度 / AI 等非编辑器字段", () => {
    const keys = Object.keys(pickEditorSettings(DEFAULT_SETTINGS)).sort();
    expect(keys).toEqual(
      [
        "autosaveIntervalMs",
        "bigDocPerformance",
        "bigDocViewport",
        "fontFamily",
        "fontSize",
        "lineHeight",
        "mathMacros",
        "memoryGuard",
        "memoryGuardThresholdMb",
        "monoFontFamily",
        "paragraphSpacing",
        "spellcheck",
        "typewriterMode",
      ].sort()
    );
  });

  it("数值字段不做变换：小数字号 / 行高原值透传", () => {
    const s: Settings = { ...DEFAULT_SETTINGS, fontSize: 15.5, lineHeight: 2 };
    const picked = pickEditorSettings(s);
    expect(picked.fontSize).toBe(s.fontSize);
    expect(picked.lineHeight).toBe(s.lineHeight);
    expect(picked.fontSize).toBe(15.5);
    expect(picked.lineHeight).toBe(2);
  });
});
