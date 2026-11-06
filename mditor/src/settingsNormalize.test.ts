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
// useMilkdown）消费的 14 字段窄切片，字段原样直传、不克隆不变换。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults";
import { normalizeSyncSettings, normalizeWorkspaceOptions, pickEditorSettings } from "./settingsNormalize";
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

  it("remoteDirs（跨端配对）：默认空对象；值 trim、空值/非串剔除、键原样；幂等", () => {
    expect(normalizeSyncSettings(undefined).remoteDirs).toEqual({});
    const once = normalizeSyncSettings({
      remoteDirs: {
        "E:\\笔记\\cmc": "  cmc  ",
        "/Docs/ws-1": "C语言",
        "E:\\gone": "   ",
        "E:\\bad": 42,
      },
    });
    expect(once.remoteDirs).toEqual({
      "E:\\笔记\\cmc": "cmc",
      "/Docs/ws-1": "C语言",
    });
    // 幂等：归一结果再归一不变。
    expect(normalizeSyncSettings(once)).toEqual(once);
  });

  it("rootOptions（v5.3）：默认空对象；空覆盖条目整键剔除", () => {
    expect(normalizeSyncSettings(undefined).rootOptions).toEqual({});
    const once = normalizeSyncSettings({
      rootOptions: {
        "E:\\ws\\a": { enabled: true }, // 与默认等价 → 键剔除
        "E:\\ws\\b": { enabled: false, extensionMode: "default" }, // 仅留 enabled
      },
    });
    expect(once.rootOptions).toEqual({
      "E:\\ws\\b": { enabled: false },
    });
    expect(normalizeSyncSettings(once)).toEqual(once);
  });

  it("rootOptions：custom 空白名单回落 default（剔除）；extensions 小写/去点/去重", () => {
    const out = normalizeSyncSettings({
      rootOptions: {
        "E:\\ws\\a": {
          extensionMode: "custom",
          extensions: ["PNG", ".Md", "md", "csv", 42, "   "],
        },
      },
    });
    expect(out.rootOptions["E:\\ws\\a"]).toEqual({
      extensionMode: "custom",
      extensions: ["png", "md", "csv"],
    });
  });

  it("rootOptions：excludedDirs 消毒（反斜杠 posix 化、拒 .. 与空段）、去重", () => {
    const out = normalizeSyncSettings({
      rootOptions: {
        "E:\\ws\\a": {
          excludedDirs: ["assets", "assets\\sub", "..\\escape", "notes/drafts/", "assets"],
        },
      },
    });
    expect(out.rootOptions["E:\\ws\\a"]!.excludedDirs).toEqual([
      "assets",
      "assets/sub",
      "notes/drafts",
    ]);
  });

  it("rootOptions：excludePatterns trim 去空行去重、超长剔除；上限 64 条", () => {
    const out = normalizeSyncSettings({
      rootOptions: {
        "E:\\ws\\a": {
          excludePatterns: ["*.tmp", "  *.tmp  ", "", "x".repeat(300)],
        },
      },
    });
    expect(out.rootOptions["E:\\ws\\a"]!.excludePatterns).toEqual(["*.tmp"]);
    const many = normalizeSyncSettings({
      rootOptions: {
        "E:\\ws\\a": { excludePatterns: Array.from({ length: 80 }, (_, i) => `p${i}`) },
      },
    });
    expect(many.rootOptions["E:\\ws\\a"]!.excludePatterns).toHaveLength(64);
  });

  it("pendingPurges（v5.3）：消毒去重、空队列剔除键、上限 2000", () => {
    expect(normalizeSyncSettings(undefined).pendingPurges).toEqual({});
    const out = normalizeSyncSettings({
      pendingPurges: {
        "E:\\ws\\a": ["assets/old.md", "assets/old.md", "..\\bad", "  notes/x.md  ", 7],
        "E:\\ws\\b": [],
      },
    });
    expect(out.pendingPurges).toEqual({
      "E:\\ws\\a": ["assets/old.md", "notes/x.md"],
    });
    const many = normalizeSyncSettings({
      pendingPurges: {
        "E:\\ws\\a": Array.from({ length: 2100 }, (_, i) => `f${i}.md`),
      },
    });
    expect(many.pendingPurges["E:\\ws\\a"]).toHaveLength(2000);
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

  it("v5.2：syncDirection / conflictPolicy 白名单归一——缺失/未知/类型错回落默认，合法值保留；幂等", () => {
    const d = normalizeSyncSettings(undefined);
    expect(d.syncDirection).toBe("bidirectional");
    expect(d.conflictPolicy).toBe("newestWins");
    expect(normalizeSyncSettings({ syncDirection: "uploadOnly" }).syncDirection).toBe("uploadOnly");
    expect(normalizeSyncSettings({ syncDirection: "downloadOnly" }).syncDirection).toBe(
      "downloadOnly"
    );
    expect(normalizeSyncSettings({ syncDirection: "sideways" }).syncDirection).toBe(
      "bidirectional"
    );
    expect(normalizeSyncSettings({ syncDirection: 42 }).syncDirection).toBe("bidirectional");
    expect(normalizeSyncSettings({ conflictPolicy: "localFirst" }).conflictPolicy).toBe(
      "localFirst"
    );
    expect(normalizeSyncSettings({ conflictPolicy: "remoteFirst" }).conflictPolicy).toBe(
      "remoteFirst"
    );
    expect(normalizeSyncSettings({ conflictPolicy: "whoWins" }).conflictPolicy).toBe("newestWins");
    const once = normalizeSyncSettings({ syncDirection: "downloadOnly", conflictPolicy: "localFirst" });
    expect(normalizeSyncSettings(once)).toEqual(once);
  });
});

describe("pickEditorSettings（P10 Editor 窄切片）", () => {
  it("提取 EditorSettings 全部 14 个字段，覆盖值与未覆盖默认值都原样直传", () => {
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

describe("normalizeWorkspaceOptions（v5.3 文件树按工作区选类型）", () => {
  it("undefined / 非对象 → 空对象", () => {
    expect(normalizeWorkspaceOptions(undefined)).toEqual({});
    expect(normalizeWorkspaceOptions("boom")).toEqual({});
    expect(normalizeWorkspaceOptions(42)).toEqual({});
  });

  it("fileTypes 白名单子集 + 去重；非法值与非法结构整键剔除", () => {
    const out = normalizeWorkspaceOptions({
      "E:\\ws\\a": { fileTypes: ["pdf", "md", "md", "bogus", 42] },
      "E:\\ws\\b": { fileTypes: "pdf" },
      "E:\\ws\\c": null,
      "E:\\ws\\d": {},
    });
    expect(out).toEqual({
      "E:\\ws\\a": { fileTypes: ["pdf", "md"] },
    });
  });

  it("空表 / 全选四类 → 剔除键（等价默认行为）", () => {
    const out = normalizeWorkspaceOptions({
      "E:\\ws\\a": { fileTypes: [] },
      "E:\\ws\\b": { fileTypes: ["md", "html", "pdf", "docx"] },
      "E:\\ws\\c": { fileTypes: ["pdf"] },
    });
    expect(out).toEqual({
      "E:\\ws\\c": { fileTypes: ["pdf"] },
    });
  });

  it("幂等：归一结果再归一不变", () => {
    const once = normalizeWorkspaceOptions({
      "E:\\ws\\a": { fileTypes: ["pdf", "md"] },
    });
    expect(normalizeWorkspaceOptions(once)).toEqual(once);
  });
});
