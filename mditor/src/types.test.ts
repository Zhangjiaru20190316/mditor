// 设置项清单快照锚点（v4.0.0 设置界面分区重构的防回归用例）。
//
// SettingsModal 的分区重组是纯 UI 改动：Settings 的字段集合、默认值与
// 持久化结构必须与重组前完全一致。本文件把这份清单钉死——任何字段的
// 增删或默认值变化都会在这里变红，提醒那是行为变更而非 UI 重组。
// 数组类字段（aiModels / aiQuickActions / excludedPaths）只锚定存在与
// 形态，完整结构由 types 定义与 store 迁移逻辑约束。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./types";

/** 重构前（v3.9.7）的 Settings 字段全集 + v4.1 新增的 motionLevel。 */
const SETTING_KEYS = [
  "theme",
  "motionLevel",
  "fontFamily",
  "monoFontFamily",
  "fontPreset",
  "monoFontPreset",
  "fontSize",
  "lineHeight",
  "paragraphSpacing",
  "sidebarWidth",
  "aiPanelWidth",
  "autosaveIntervalMs",
  "focusMode",
  "typewriterMode",
  "spellcheck",
  "annoDiagPanel",
  "memoryGuard",
  "memoryGuardThresholdMb",
  "customCssPath",
  "aiProvider",
  "aiBaseUrl",
  "aiApiKey",
  "aiModel",
  "aiTemperature",
  "aiMaxTokens",
  "aiTopP",
  "aiSystemPrompt",
  "aiContextStrategy",
  "aiHistoryBudgetTokens",
  "aiAnnotateMaxChars",
  "aiThinkingStrength",
  "aiModels",
  "aiActiveModelId",
  "aiQuickActions",
  "excludedPaths",
] as const;

/** 重构前（v3.9.7）的标量默认值。 */
const SCALAR_DEFAULTS: Record<string, unknown> = {
  theme: "light",
  motionLevel: "balanced",
  fontFamily:
    '"Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
  monoFontFamily:
    '"JetBrains Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
  fontPreset: "system",
  monoFontPreset: "jetbrains",
  fontSize: 16,
  lineHeight: 1.75,
  paragraphSpacing: 16,
  sidebarWidth: 260,
  aiPanelWidth: 360,
  autosaveIntervalMs: 30_000,
  focusMode: false,
  typewriterMode: false,
  spellcheck: true,
  annoDiagPanel: false,
  memoryGuard: true,
  memoryGuardThresholdMb: 2500,
  customCssPath: "",
  aiProvider: "custom",
  aiBaseUrl: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiTemperature: 0.7,
  aiMaxTokens: 4096,
  aiTopP: 1,
  aiSystemPrompt: "",
  aiContextStrategy: "standard",
  aiHistoryBudgetTokens: 8000,
  aiAnnotateMaxChars: 4000,
  aiThinkingStrength: "off",
  aiActiveModelId: "default",
};

describe("settings inventory（v4.0.0 分区重构防回归锚点）", () => {
  it("Settings 字段集合与重构前一致（无增删）", () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(
      [...SETTING_KEYS].sort()
    );
  });

  it("标量默认值与重构前一致", () => {
    const scalars = Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS).filter(([, v]) => typeof v !== "object")
    );
    expect(scalars).toEqual(SCALAR_DEFAULTS);
  });

  it("结构类字段（模型 / 快捷操作 / 已移除项）仍为数组", () => {
    expect(Array.isArray(DEFAULT_SETTINGS.aiModels)).toBe(true);
    expect(Array.isArray(DEFAULT_SETTINGS.aiQuickActions)).toBe(true);
    expect(Array.isArray(DEFAULT_SETTINGS.excludedPaths)).toBe(true);
  });
});
