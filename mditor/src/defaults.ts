// 运行时默认值与预设（Q4「types 必是类型」拆分：本文件承接 src/types.ts
// 原有的全部运行时导出——默认值字面量、预设数据与小运行时函数；types.ts
// 只留纯类型）。设置归一 / 切片函数在 settingsNormalize.ts。

import type {
  ActiveMarks,
  AiModelConfig,
  AiProviderPreset,
  FontPreset,
  S3ProviderPreset,
  Settings,
  SyncSettings,
  Theme,
} from "./types";

/**
 * 深色主题判定（单一事实源）：dark / claude-dark / ios-dark 三个深色值。
 * 此前 App（PNG 导出底色）与 MarkdownText（data-md-theme）各自手工枚举
 * 三连判断，新增深色主题时容易漏改一处——统一走本谓词。
 * （Q4 拆分：小运行时函数随默认值数据迁入本文件；类型 Theme 在 types.ts。）
 */
export function isDarkTheme(theme: Theme): boolean {
  return theme === "dark" || theme === "claude-dark" || theme === "ios-dark";
}

/** Built-in provider templates. Selecting one in settings pre-fills the URL. */
export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
    keyHint: "sk-...",
  },
  {
    id: "deepseek",
    name: "DeepSeek 深度求索",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    needsKey: true,
    keyHint: "sk-...",
  },
  {
    id: "glm",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    needsKey: true,
    keyHint: "xxx.yyy",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    needsKey: true,
    keyHint: "sk-...",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    needsKey: true,
    keyHint: "sk-or-...",
  },
  {
    id: "ollama",
    name: "Ollama (本地)",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    needsKey: false,
  },
];

export const AI_PROVIDER_BY_ID: Record<string, AiProviderPreset> = Object.fromEntries(
  AI_PROVIDERS.map((p) => [p.id, p])
);

/* -------------------------------------------------------------------------- */
/* 云同步（v4.12）：用户自带 S3 兼容对象存储（BYO storage）                      */
/* -------------------------------------------------------------------------- */

/** 内置 S3 兼容服务商预设（v4.12 云同步；均以各厂商控制台实际信息为准）。 */
export const SYNC_PROVIDERS: S3ProviderPreset[] = [
  {
    id: "qiniu",
    name: "七牛云 Kodo",
    endpointTemplate: "https://s3.{region}.qiniucs.com",
    regionHint: "cn-east-1（以控制台为准）",
    pathStyleDefault: false,
  },
  {
    id: "aliyun-oss",
    name: "阿里云 OSS",
    endpointTemplate: "https://oss-{region}.aliyuncs.com",
    regionHint: "cn-hangzhou",
    pathStyleDefault: false,
  },
  {
    id: "cloudflare-r2",
    name: "Cloudflare R2",
    endpointTemplate: "https://{accountId}.r2.cloudflarestorage.com",
    regionHint: "auto（固定）",
    pathStyleDefault: true,
  },
  {
    id: "minio",
    name: "MinIO / 自建",
    regionHint: "us-east-1（任意）",
    pathStyleDefault: true,
  },
  {
    id: "aws",
    name: "AWS S3",
    // endpoint 留空 = 使用 AWS 默认端点（按 region 自动构造）。
    regionHint: "us-east-1",
    pathStyleDefault: false,
  },
  {
    id: "custom",
    name: "自定义",
    pathStyleDefault: false,
  },
];

/** 合法 provider id 集合（string 宽类型——归一入口要校验未知字符串）。 */
export const SYNC_PROVIDER_IDS: ReadonlySet<string> = new Set<string>(
  SYNC_PROVIDERS.map((p) => p.id as string)
);

/** 云同步默认值：全关、无凭证——默认零网络行为。 */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  enabled: false,
  provider: "custom",
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  pathStyle: false,
  prefix: "mditor/",
  autoSync: true,
  autoSyncIntervalMin: 10,
  syncOnStart: true,
};

/**
 * Generate a fresh AiModelConfig, optionally seeded from a provider preset
 * (prefills baseUrl + a default model). The id is unique enough for React keys.
 */
export function newAiModelId(): string {
  // Prefer crypto.randomUUID when available; fall back to a timestamp/random id.
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyAiModel(preset?: AiProviderPreset): AiModelConfig {
  return {
    id: newAiModelId(),
    name: preset ? preset.name : "新模型",
    provider: preset ? preset.id : "custom",
    baseUrl: preset ? preset.baseUrl : "",
    apiKey: "",
    model: preset ? preset.defaultModel : "",
  };
}

/** 空标记（无选区/编辑器未就绪）。共享常量——调用方只读；需要可变副本时
 *  展开 `{ ...EMPTY_MARKS }`。收敛此前 4 处重复字面量。 */
export const EMPTY_MARKS: ActiveMarks = {
  bold: false,
  highlight: false,
  italic: false,
  strike: false,
  code: false,
  color: null,
};

export const DEFAULT_SETTINGS: Settings = {
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
  devMode: false,
  bigDocPerformance: false,
  bigDocViewport: false,
  mathAutoNumber: false,
  mathMacros: "",
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
  aiPanelMode: "chat",
  agentWriteMode: "confirm",
  aiModels: [
    {
      id: "default",
      name: "默认模型",
      provider: "custom",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
    },
  ],
  aiActiveModelId: "default",
  aiQuickActions: [
    { label: "总结全文", prompt: "请用 3-5 个要点总结这篇笔记。", scope: "full" },
    {
      label: "润色全文",
      prompt: "请润色这篇笔记的措辞，使其更通顺专业，输出完整的润色后全文（仅 Markdown）。",
      scope: "full",
    },
    {
      label: "纠正错别字",
      prompt: "请只纠正这篇笔记中的错别字和标点错误，不要改动内容与格式，输出完整全文。",
      scope: "full",
    },
    {
      label: "扩写",
      prompt: "请在保持原意的前提下扩写这篇笔记，补充更多细节，输出完整全文。",
      scope: "full",
    },
    {
      label: "润色选区",
      prompt: "请润色以下选中的文字，使其更通顺专业，只输出润色后的片段（纯文本或 Markdown）。\n\n{selection}",
      scope: "selection",
    },
    {
      label: "翻译为英文",
      prompt: "请把以下选中的文字翻译成英文，只输出译文。\n\n{selection}",
      scope: "selection",
    },
    {
      label: "解释",
      prompt: "请解释以下选中的内容，条理清晰地说明其含义。\n\n{selection}",
      scope: "selection",
    },
  ],
  excludedPaths: [],
  vaultIndexEnabled: true,
  wikiLinksEnabled: true,
  bibliographyPath: "",
  citationStyle: "numeric",
  flashcardsEnabled: true,
  ragEnabled: false,
  ragEmbedBaseUrl: "",
  ragEmbedApiKey: "",
  ragEmbedModel: "",
  sync: { ...DEFAULT_SYNC_SETTINGS },
};

// 正文字体预设（选择行为说明见 types.ts FontPreset / 设置面板回显逻辑）。
export const FONT_PRESETS: FontPreset[] = [
  {
    id: "system",
    name: "系统默认",
    stack:
      '"Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: "ios",
    name: "iOS SF 风格",
    stack:
      '-apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", "HarmonyOS Sans SC", sans-serif',
  },
  {
    id: "claude",
    name: "Claude 风格",
    stack:
      'ui-sans-serif, -apple-system, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: "serif",
    name: "衬线优雅",
    stack:
      '"Source Han Serif SC", "Noto Serif SC", "Songti SC", Georgia, serif',
  },
  {
    id: "wenkai",
    name: "霞鹜文楷",
    stack: '"LXGW WenKai", "Source Han Sans SC", system-ui, sans-serif',
  },
  {
    id: "sans",
    name: "思源黑体",
    stack: '"Source Han Sans SC", "Noto Sans SC", system-ui, sans-serif',
  },
];

/** 代码字体预设。 */
export const MONO_FONT_PRESETS: FontPreset[] = [
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    stack: '"JetBrains Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
  },
  {
    id: "cascadia",
    name: "Cascadia Code",
    stack: '"Cascadia Code", "JetBrains Mono", Consolas, "SF Mono", Menlo, monospace',
  },
  {
    id: "firacode",
    name: "Fira Code",
    stack: '"Fira Code", "JetBrains Mono", Consolas, "SF Mono", Menlo, monospace',
  },
  {
    id: "sfmono",
    name: "SF Mono",
    stack: '"SF Mono", "JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace',
  },
  {
    id: "consolas",
    name: "Consolas",
    stack: 'Consolas, "JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, monospace',
  },
];
