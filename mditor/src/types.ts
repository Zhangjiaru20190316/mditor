// Shared types for the Mditor frontend.

export type Theme = "light" | "dark" | "sepia" | "claude" | "claude-dark";

export type EditMode = "wysiwyg" | "ir" | "sv";

/**
 * AI provider id. "custom" leaves the Base URL / model untouched. Any preset
 * fills the Base URL with a known template (the user can still edit it after).
 */
export type AiProvider =
  | "custom"
  | "openai"
  | "deepseek"
  | "glm"
  | "moonshot"
  | "openrouter"
  | "ollama";

/** Where a quick action runs: against the whole note, or the selection. */
export type QuickActionScope = "full" | "selection";

/**
 * AI "thinking strength". Controls how hard a reasoning model thinks before
 * answering. Mapped per-provider to the right request field in Rust (see
 * `thinking_fields` in ai.rs): OpenAI/OpenRouter/DeepSeek use `reasoning_effort`,
 * 智谱 GLM / Moonshot use `thinking.budget_tokens`. "off" sends nothing.
 */
export type ThinkingStrength = "off" | "low" | "medium" | "high";

/**
 * One configured AI model connection (multi-model support). Only connection
 * info lives here; sampling knobs (temperature / thinking strength / system
 * prompt / max tokens / top_p) are shared globally across models.
 */
export interface AiModelConfig {
  /** Stable unique id so React keys + active selection stay stable. */
  id: string;
  /** User-facing label, e.g. "GPT-4o 日常". */
  name: string;
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface QuickAction {
  /** Short button label shown in the panel / selection toolbar. */
  label: string;
  /** The prompt template. May contain {selection} placeholder (scope=selection). */
  prompt: string;
  scope: QuickActionScope;
}

export interface AiProviderPreset {
  id: Exclude<AiProvider, "custom">;
  name: string;
  baseUrl: string;
  /** Model name hint shown as placeholder / used to prefill when blank. */
  defaultModel: string;
  /** Whether an API key is typically required. */
  needsKey: boolean;
  keyHint?: string;
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

export interface Settings {
  theme: Theme;
  /** Prose font family stack. */
  fontFamily: string;
  /** Monospace font for code. */
  monoFontFamily: string;
  /** 当前字体预设名（用于回显下拉框；为空表示自定义）。 */
  fontPreset: string;
  /** 当前代码字体预设名（用于回显下拉框；为空表示自定义）。 */
  monoFontPreset: string;
  /** Body font size in px. */
  fontSize: number;
  /** Line height (unitless). */
  lineHeight: number;
  /** Paragraph bottom margin in px. */
  paragraphSpacing: number;
  /** 侧边栏宽度（px），可拖拽调节并持久化。 */
  sidebarWidth: number;
  /** AI 面板宽度（px），可拖拽调节并持久化。 */
  aiPanelWidth: number;
  /** Autosave interval in milliseconds (0 = off). */
  autosaveIntervalMs: number;
  /** Focus mode: hide sidebars. */
  focusMode: boolean;
  /**
   * 打字机模式（V3.6）：光标行始终保持在视口中部——富文本模式经选区矩形
   * 平滑滚动滚动容器，源码模式由 CodeMirror 的 scrollIntoView(center) 实现。
   */
  typewriterMode: boolean;
  /** Enable the browser's native spellcheck on the editor surface. */
  spellcheck: boolean;
  /**
   * 内存守护：定期检查 JS 堆，超过 memoryGuardThresholdMb 时自愈——先尝试
   * 销毁重建编辑器（软），无效则升级为整页 reload（硬，唯一可靠回收手段）。
   * 编辑器是 Milkdown/ProseMirror（纯 JS，无 GopherJS），其状态全在 V8 堆上，
   * usedJSHeapSize 已如实包含；useMilkdown 已串行化 destroy→create，故软重建
   * 确能回收旧实例，仅当重建仍不回落时才 reload 兜底。由 hooks/useMemoryGuard
   * 驱动（不再依赖 autosave，从而覆盖未命名与干净闲置文档）。重建/reload 会
   * 清空撤销历史（内容不丢，reload 前快照会话以便回填）。
   */
  memoryGuard: boolean;
  /**
   * JS 堆用量阈值（MB）。开启 memoryGuard 后，useMemoryGuard 每 ~10s 检查一次
   * performance.memory.usedJSHeapSize，超过该阈值即触发自愈（soft recreate，无
   * 效则 reload）。默认 2500MB：64 位 WebView2 渲染进程堆上限约 4.4GB，2500MB
   * （~57%）既显著减少复杂操作中的自愈打扰，又距临界兜底（0.9×上限≈3.95GB 自
   * 动 reload 防崩）留 ~1.45GB 安全余量。Milkdown/ProseMirror 的状态 + React +
   * GPU 缓冲都在这同一个 JS 堆里，usedJSHeapSize 已如实反映；编辑器无 WASM，
   * 该度量即为真实占用，故阈值/reload 可确信地回落。
   */
  memoryGuardThresholdMb: number;
  /** Optional absolute path to a user CSS file applied on top of the theme. */
  customCssPath: string;
  /** Which provider preset is selected (drives Base URL pre-fill). "custom" = manual. */
  aiProvider: AiProvider;
  /** AI provider base URL (OpenAI-compatible), e.g. https://api.openai.com/v1 */
  aiBaseUrl: string;
  /** API key for the AI provider (empty allowed for local servers). */
  aiApiKey: string;
  /** Model name, e.g. gpt-4o-mini, deepseek-chat, glm-4-flash. */
  aiModel: string;
  /** Sampling temperature 0..2. */
  aiTemperature: number;
  /** Max output tokens. 0 = do not send the field (let provider default apply). */
  aiMaxTokens: number;
  /** Nucleus sampling probability 0..1. */
  aiTopP: number;
  /** Custom system prompt override; empty string = use the built-in default. */
  aiSystemPrompt: string;
  /**
   * Reasoning/thinking strength for reasoning-capable models. "off" sends no
   * thinking field. See ThinkingStrength / the provider mapping in ai.rs.
   */
  aiThinkingStrength: ThinkingStrength;
  /**
   * Configured model connections (multi-model). The active one is selected by
   * `aiActiveModelId`. Kept alongside the legacy flat `aiBaseUrl/aiApiKey/
   * aiModel/aiProvider` fields, which are used as a migration source / fallback
   * for older mditor.json files (see migrateSettings in store.ts).
   */
  aiModels: AiModelConfig[];
  /** id of the model in `aiModels` that is currently active in the AI panel. */
  aiActiveModelId: string;
  /** User-customisable quick actions shown in the AI panel / selection toolbar. */
  aiQuickActions: QuickAction[];
  /**
   * Absolute paths hidden from the workspace file tree via「从工作区移除」.
   * The files/folders stay on disk — this list only suppresses them in the
   * tree (VS Code "Remove from Workspace" style). Managed/restoreable in 设置.
   */
  excludedPaths: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "light",
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
  memoryGuard: true,
  memoryGuardThresholdMb: 2500,
  customCssPath: "",
  aiProvider: "custom",
  aiBaseUrl: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiTemperature: 0.7,
  aiMaxTokens: 0,
  aiTopP: 1,
  aiSystemPrompt: "",
  aiThinkingStrength: "off",
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
};

/* -------------------------------------------------------------------------- */
/* 块级右键菜单（BlockContextMenu）共享类型                                      */
/* -------------------------------------------------------------------------- */

/** 文档块的语义类型。列表项按其父列表归类（任务项单独一类）。 */
export type BlockKind =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "code_block"
  | "bullet_list"
  | "ordered_list"
  | "task_list"
  | "hr"
  | "table"
  | "image"
  | "math_block"
  | "html"
  | "other";

/** 右键菜单可切换的目标块类型（转换为 / 取消转换）。 */
export type BlockTargetKind =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "code_block"
  | "bullet_list"
  | "ordered_list"
  | "task_list"
  | "hr";

/** 右键菜单对当前块的一次快照描述（由 Milkdown facade 从点击坐标解析）。 */
export interface BlockInfo {
  /** 当前块语义类型。 */
  kind: BlockKind;
  /** heading 的层级 1..6；非标题为 null。 */
  headingLevel: number | null;
  /** 可移动单元（顶层块，或列表中的整个列表项）的文档区间。 */
  from: number;
  to: number;
  /** 上方存在可交换的相邻块（跳过空段落）。 */
  canMoveUp: boolean;
  /** 下方存在可交换的相邻块（跳过空段落）。 */
  canMoveDown: boolean;
  /** 点击处位于表格内（提供插入/删除行列操作）。 */
  inTable: boolean;
  /** 点击处位于链接文字上。 */
  link: { from: number; to: number; href: string } | null;
  /** 点击处位于图片上（块级或行内）。 */
  image: { pos: number; src: string } | null;
}

export interface RecentFile {
  path: string;
  name: string;
  /** ISO timestamp of last open. */
  openedAt: string;
}

/**
 * One heading of the LIVE ProseMirror document, as extracted by the editor
 * (useMilkdown). `id` is Milkdown's own attrs.id — i.e. exactly the id on the
 * rendered <hN> — so outline jumps can never diverge from the DOM anchor.
 */
export interface FlatHeading {
  level: number; // 1..6
  /** Rendered heading text (node.textContent — inline syntax stripped). */
  text: string;
  /** Milkdown heading id — identical to the rendered <hN id>. Headings whose
   *  id hasn't been stamped yet are not emitted. */
  id: string;
}

export interface OutlineNode {
  level: number; // 1..6
  text: string;
  /** Anchor id: Milkdown attrs.id (doc-derived) or source slug (sv fallback). */
  id: string;
  children: OutlineNode[];
  /** 0-based source line of the heading text (source-parse path only; used
   *  by sv-mode outline jumps to scroll the textarea). */
  line?: number;
}

export interface DocState {
  /** Absolute path of the file on disk, or null for an untitled buffer. */
  path: string | null;
  /** Markdown source. */
  content: string;
  /** Whether the buffer has unsaved changes vs. the last save/disk read. */
  dirty: boolean;
}

/**
 * One entry of the document tab bar (V3.6 多标签页). Only the ACTIVE tab lives
 * in the editor / useFile; switching away snapshots the live content here so
 * untitled dirty buffers survive round-trips. `key` is stable across renders —
 * file tabs are keyed by path, untitled tabs by a counter.
 */
export interface TabItem {
  key: string;
  /** Disk path, or null for an untitled buffer. */
  path: string | null;
  /** Display name (basename or 未命名.md). */
  name: string;
  /** Dirty flag mirrored from useFile while this tab is active. */
  dirty: boolean;
  /** Content snapshot taken when the tab was switched away from / created. */
  content: string;
}

/**
 * 正文字体预设。选择某个预设会一次性写入 fontFamily，并把 fontPreset 记录下来
 * （供设置面板下拉框回显；用户随后手动改字体栈会把 fontPreset 置空为「自定义」）。
 */
export interface FontPreset {
  id: string;
  name: string;
  stack: string;
}

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "system",
    name: "系统默认",
    stack:
      '"Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
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
