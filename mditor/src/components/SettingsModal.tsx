// Settings dialog. Edits the Settings object via useSettings.update.
//
// v4.1: 单列长滚动改为左导航双栏——左列竖排分区导航（激活指示条随切换平滑
// 滑动），右列仅渲染当前分区（切换只重渲染右列相关 Field）；「性能与诊断」
// 从折叠组升为正式导航分区，「高级参数」保留在 AI 分区内折叠。纯 UI 重组
// ——draft/apply 读写流、每项控件与默认值不变（types.test.ts 快照锚定）。
//
// Custom CSS: pick a .css file on disk; we read it and inject it live.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AiModelConfig,
  AiProvider,
  MotionLevel,
  QuickAction,
  QuickActionScope,
  Settings,
  Theme,
  ThinkingStrength,
} from "../types";
import { AI_PROVIDERS, AI_PROVIDER_BY_ID, emptyAiModel, FONT_PRESETS, MONO_FONT_PRESETS } from "../types";
import { testConnection } from "../lib/ai";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { CloseIcon, ChevronRightIcon } from "./icons";

/** 分区导航项（固定高度，供滑动指示条做等距 translateY 定位）。 */
const SECTIONS = [
  "外观",
  "排版",
  "编辑行为",
  "性能与诊断",
  "AI 助手",
  "快捷操作",
  "工作区",
] as const;
/** 导航项高度 + 相邻间距（px）——指示条 translateY 的步长。 */
const NAV_ITEM_H = 34;
const NAV_STEP = NAV_ITEM_H + 4;

const MOTION_LEVELS: Array<{ value: MotionLevel; label: string }> = [
  { value: "none", label: "无" },
  { value: "balanced", label: "平衡" },
  { value: "lively", label: "生动" },
];

/** 关闭时的退场动画时长（useDelayedUnmount，与 CSS .closing 动画对齐）。 */
const EXIT_MS = 240;

interface Props {
  open: boolean;
  settings: Settings;
  /** Current workspace root, used to show excluded paths as relative. */
  workspace?: string | null;
  onClose: () => void;
  onChange: (patch: Partial<Settings>) => Promise<void>;
}

export function SettingsModal({ open, settings, workspace, onClose, onChange }: Props) {
  // local draft so typing is responsive; commit on blur / apply
  const [draft, setDraft] = useState<Settings>(settings);
  // Sync the draft ONCE when the dialog opens. Re-syncing on every `settings`
  // change while open would clobber the user's in-progress edits whenever an
  // external update lands (e.g. switching models from the AI panel writes
  // aiActiveModelId mid-edit). The effect closure captures the `settings` of
  // the render where `open` flipped, which is the latest value at that moment.
  const [section, setSection] = useState(0);
  useEffect(() => {
    if (open) {
      setDraft(settings);
      setSection(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draft/分区只在打开瞬间同步一次
  }, [open]);

  // NOTE: all hooks MUST stay above the `if (!open) return null` early return.
  // Placing useState below it makes the hook count differ between closed/open
  // renders, which throws "Rendered more hooks than during the previous render"
  // and unmounts the whole tree (the "settings opens blank" bug).
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState("");
  const [testOk, setTestOk] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // v4.1 退场动效：关闭后保持挂载 240ms 播 .closing 动画再卸载。
  const mounted = useDelayedUnmount(open, EXIT_MS);

  if (!mounted) return null;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // Multi-model list helpers (operate on draft.aiModels / draft.aiActiveModelId).
  const models = draft.aiModels;
  const updateModel = (idx: number, patch: Partial<AiModelConfig>) => {
    const next = models.map((mm, i) => (i === idx ? { ...mm, ...patch } : mm));
    set("aiModels", next);
  };
  const removeModel = (idx: number) => {
    const removed = models[idx];
    const next = models.filter((_, i) => i !== idx);
    // Keep at least one entry; if we removed the active model, re-point active id.
    if (next.length === 0) return;
    let activeId = draft.aiActiveModelId;
    if (removed && removed.id === activeId) activeId = next[0].id;
    setDraft((d) => ({ ...d, aiModels: next, aiActiveModelId: activeId }));
  };
  const addModel = () => {
    const mm = emptyAiModel();
    setDraft((d) => ({ ...d, aiModels: [...d.aiModels, mm] }));
  };
  const setActiveModel = (id: string) => set("aiActiveModelId", id);
  /** Picking a provider preset for a specific row prefills its Base URL + model. */
  const pickProviderForModel = (idx: number, id: AiProvider) => {
    if (id === "custom") {
      updateModel(idx, { provider: "custom" });
      return;
    }
    const preset = AI_PROVIDER_BY_ID[id];
    if (!preset) {
      updateModel(idx, { provider: "custom" });
      return;
    }
    const row = models[idx];
    updateModel(idx, {
      provider: id,
      baseUrl: preset.baseUrl,
      // Only prefill the model when the row doesn't already have one.
      model: row.model.trim() || preset.defaultModel,
    });
  };

  // Quick-action editor helpers (operate on draft.aiQuickActions).
  const qa = draft.aiQuickActions;
  const updateQa = (idx: number, patch: Partial<QuickAction>) => {
    const next = qa.map((a, i) => (i === idx ? { ...a, ...patch } : a));
    set("aiQuickActions", next);
  };
  const removeQa = (idx: number) => set("aiQuickActions", qa.filter((_, i) => i !== idx));
  const addQa = () =>
    set("aiQuickActions", [
      ...qa,
      { label: "新操作", prompt: "", scope: "full" as QuickActionScope },
    ]);

  // Excluded-paths (removed from workspace, files kept on disk) helpers.
  const excluded = draft.excludedPaths;
  const restoreExcluded = (p: string) =>
    set("excludedPaths", excluded.filter((x) => x !== p));
  const restoreAllExcluded = () => set("excludedPaths", []);
  // Show relative to the workspace root when possible, else the absolute path.
  const displayPath = (p: string): string => {
    if (
      workspace &&
      p !== workspace &&
      (p.startsWith(workspace + "\\") || p.startsWith(workspace + "/"))
    ) {
      return p.slice(workspace.length + 1);
    }
    return p;
  };

  const pickCss = async () => {
    const p = await openDialog({
      multiple: false,
      filters: [{ name: "CSS", extensions: ["css"] }],
    });
    if (typeof p === "string") set("customCssPath", p);
  };

  const applyAll = async () => {
    await onChange(draft);
    onClose();
  };

  // Test the AI config against the current draft. The request is built from
  // the draft values directly — "测试连接" must NOT persist the draft (the user
  // may still be mid-edit and hit 取消); success only shows a hint. Saving
  // happens exclusively via 应用 (applyAll).
  const runTest = async () => {
    setTesting(true);
    setTestMsg("");
    try {
      await testConnection(draft);
      setTestOk(true);
      setTestMsg("连接成功");
    } catch (e) {
      setTestOk(false);
      setTestMsg(String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={`modal-backdrop${open ? "" : " closing"}`} onClick={onClose}>
      <div className="modal-card settings-card" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>设置</h2>
          <button className="modal-x" onClick={onClose}><CloseIcon size={14} /></button>
        </header>

        {/* v4.1 双栏：左列分区导航（激活指示条平滑滑动），右列仅渲染当前
            分区——切换只重渲染右列相关 Field，控件与 draft 读写完全不变
            （设置项清单有 types.test.ts 快照锚定）。 */}
        <section className="modal-body settings-body">
          <nav className="settings-nav" aria-label="设置分区">
            <span
              className="settings-nav-ind"
              style={{ transform: `translateY(${section * NAV_STEP}px)` }}
              aria-hidden="true"
            />
            {SECTIONS.map((label, i) => (
              <button
                key={label}
                type="button"
                className={`settings-nav-btn${i === section ? " active" : ""}`}
                style={{ height: NAV_ITEM_H }}
                aria-current={i === section ? "true" : undefined}
                onClick={() => setSection(i)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="settings-pane" key={section}>
            {section === 0 && (
              <>
                <Field label="主题">
                  <select
                    value={draft.theme}
                    onChange={(e) => set("theme", e.target.value as Theme)}
                  >
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                    <option value="sepia">护眼</option>
                    <option value="claude">Claude（暖纸感）</option>
                    <option value="claude-dark">Claude Dark</option>
                  </select>
                </Field>

                <Field label="动效强度">
                  <div className="seg" role="radiogroup" aria-label="动效强度">
                    {MOTION_LEVELS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={draft.motionLevel === value}
                        className={`seg-btn${draft.motionLevel === value ? " active" : ""}`}
                        onClick={() => set("motionLevel", value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="hint">
                    「无」等同系统减少动态效果（动画全部禁用、跳转瞬时）；「平衡」为默认完整体验；「生动」额外增加级联与弹性微动效。系统开启「减少动态效果」时始终按「无」生效。
                  </span>
                </Field>

                <Field label="字体预设">
                  <select
                    value={draft.fontPreset}
                    onChange={(e) => {
                      const id = e.target.value;
                      const p = FONT_PRESETS.find((x) => x.id === id);
                      if (p) setDraft((d) => ({ ...d, fontPreset: id, fontFamily: p.stack }));
                      else set("fontPreset", "");
                    }}
                  >
                    <option value="">自定义</option>
                    {FONT_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span className="hint">选择预设会覆盖下方字体栈；也可直接手动编辑（将切回「自定义」）。</span>
                </Field>

                <Field label="正文字体栈">
                  <input
                    type="text"
                    className="mono"
                    value={draft.fontFamily}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, fontFamily: e.target.value, fontPreset: "" }))
                    }
                  />
                </Field>

                <Field label="代码字体预设">
                  <select
                    value={draft.monoFontPreset}
                    onChange={(e) => {
                      const id = e.target.value;
                      const p = MONO_FONT_PRESETS.find((x) => x.id === id);
                      if (p) setDraft((d) => ({ ...d, monoFontPreset: id, monoFontFamily: p.stack }));
                      else set("monoFontPreset", "");
                    }}
                  >
                    <option value="">自定义</option>
                    {MONO_FONT_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="代码字体栈">
                  <input
                    type="text"
                    className="mono"
                    value={draft.monoFontFamily}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, monoFontFamily: e.target.value, monoFontPreset: "" }))
                    }
                  />
                </Field>

                <Field label="自定义 CSS 文件">
                  <div className="css-row">
                    <input
                      type="text"
                      className="mono"
                      placeholder="选择一个 .css 文件，或留空"
                      value={draft.customCssPath}
                      onChange={(e) => set("customCssPath", e.target.value)}
                    />
                    <button onClick={pickCss}>浏览…</button>
                  </div>
                  <span className="hint">
                    自定义样式会覆盖主题，类似 Typora 的自定义 CSS。
                  </span>
                </Field>
              </>
            )}

            {section === 1 && (
              <>
                <Field label="正文字号 (px)">
                  <input
                    type="number"
                    min={12}
                    max={28}
                    value={draft.fontSize}
                    onChange={(e) => set("fontSize", Number(e.target.value) || 16)}
                  />
                </Field>

                <Field label="行高">
                  <input
                    type="number"
                    step={0.05}
                    min={1}
                    max={2.5}
                    value={draft.lineHeight}
                    onChange={(e) => set("lineHeight", Number(e.target.value) || 1.75)}
                  />
                </Field>

                <Field label="段落间距 (px)">
                  <input
                    type="number"
                    min={0}
                    max={48}
                    value={draft.paragraphSpacing}
                    onChange={(e) => set("paragraphSpacing", Number(e.target.value) || 16)}
                  />
                </Field>
              </>
            )}

            {section === 2 && (
              <>
                <Field label="拼写检查">
                  <input
                    type="checkbox"
                    checked={draft.spellcheck}
                    onChange={(e) => set("spellcheck", e.target.checked)}
                  />
                  <span className="hint">使用浏览器原生拼写检查（中英文）</span>
                </Field>

                <Field label="打字机模式">
                  <input
                    type="checkbox"
                    checked={draft.typewriterMode}
                    onChange={(e) => set("typewriterMode", e.target.checked)}
                  />
                  <span className="hint">光标行始终保持在窗口中部（两种编辑模式均生效）</span>
                </Field>

                <Field label="自动保存间隔 (毫秒, 0=关闭)">
                  <input
                    type="number"
                    step={1000}
                    min={0}
                    value={draft.autosaveIntervalMs}
                    onChange={(e) => set("autosaveIntervalMs", Number(e.target.value) || 0)}
                  />
                </Field>
              </>
            )}

            {section === 3 && (
              <>
                <Field label="大文档性能模式">
                  <input
                    type="checkbox"
                    checked={draft.bigDocPerformance}
                    onChange={(e) => set("bigDocPerformance", e.target.checked)}
                  />
                  <span className="hint">
                    文档超过 3000 行或 500KB 时自动关闭代码高亮与公式渲染以降低
                    内存占用。关闭后大文档保持完整渲染，但内存占用会明显升高；
                    切换后当前文档会自动重建编辑器（撤销历史清空）。
                  </span>
                </Field>
                <Field label="内存自动优化">
                  <input
                    type="checkbox"
                    checked={draft.memoryGuard}
                    onChange={(e) => set("memoryGuard", e.target.checked)}
                  />
                  <span className="hint">
                    长时间编辑后编辑器（Markdown 解析引擎）内存只增不减。开启后，自动保存时若
                    内存超过阈值会静默重建编辑器以释放内存（内容已保存，撤销历史会清空）。
                  </span>
                </Field>
                <Field label="内存优化阈值 (MB)">
                  <input
                    type="number"
                    step={100}
                    min={256}
                    disabled={!draft.memoryGuard}
                    value={draft.memoryGuardThresholdMb}
                    onChange={(e) =>
                      set("memoryGuardThresholdMb", Number(e.target.value) || 0)
                    }
                  />
                  <span className="hint">JS 堆占用超过此值时触发重建（默认 1200）。</span>
                </Field>
                <Field label="批注诊断面板">
                  <input
                    type="checkbox"
                    checked={draft.annoDiagPanel}
                    onChange={(e) => set("annoDiagPanel", e.target.checked)}
                  />
                  <span className="hint">
                    批注链路事件流 / 整篇重写计数 / 批注体检（快捷键 Ctrl+Alt+D）
                  </span>
                </Field>
                <Field label="开发者模式">
                  <input
                    type="checkbox"
                    checked={draft.devMode}
                    onChange={(e) => set("devMode", e.target.checked)}
                  />
                  <span className="hint">
                    全量记录后台数据（滚动/批注/命令事件流、全局异常、内存心跳）到日志文件，
                    自动分析异常并按 MD-XXXX 错误代码弹出警告（普通异常为右上角警告卡，
                    严重异常原生弹窗）。日志在 应用数据目录/logs/ 下，自动轮转；仅排查
                    问题时开启。
                  </span>
                </Field>
              </>
            )}

            {section === 4 && (
              <>
                <span className="hint" style={{ marginTop: -2 }}>
                  可配置多个模型，在 AI 面板顶部一键切换。温度、思考强度、系统提示词为全局共享。
                </span>

                <div className="model-editor">
                  {models.map((mm, i) => {
                    const active = mm.id === draft.aiActiveModelId;
                    return (
                      <div className="model-row" key={mm.id}>
                        <div className="model-row-head">
                          <label className="model-active" title="设为当前使用的模型">
                            <input
                              type="radio"
                              name="ai-active-model"
                              checked={active}
                              onChange={() => setActiveModel(mm.id)}
                            />
                            <input
                              className="model-name"
                              type="text"
                              placeholder="名称，如 GPT-4o 日常"
                              value={mm.name}
                              onChange={(e) => updateModel(i, { name: e.target.value })}
                            />
                          </label>
                          <button
                            className="model-del"
                            type="button"
                            title="删除该模型"
                            onClick={() => removeModel(i)}
                            disabled={models.length <= 1}
                          >
                            <CloseIcon size={11} />
                          </button>
                        </div>
                        <div className="model-row-grid">
                          <select
                            className="model-provider"
                            value={mm.provider}
                            onChange={(e) => pickProviderForModel(i, e.target.value as AiProvider)}
                          >
                            <option value="custom">自定义</option>
                            {AI_PROVIDERS.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          <input
                            className="model-baseurl mono"
                            type="text"
                            placeholder="Base URL，如 https://api.openai.com/v1"
                            value={mm.baseUrl}
                            onChange={(e) => updateModel(i, { baseUrl: e.target.value })}
                          />
                          <input
                            className="model-key mono"
                            type="password"
                            placeholder="API Key（本地服务可留空）"
                            value={mm.apiKey}
                            onChange={(e) => updateModel(i, { apiKey: e.target.value })}
                          />
                          <input
                            className="model-name-id mono"
                            type="text"
                            placeholder="模型名，如 gpt-4o-mini / glm-4.6"
                            value={mm.model}
                            onChange={(e) => updateModel(i, { model: e.target.value })}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <button className="model-add" type="button" onClick={addModel}>
                    + 添加模型
                  </button>
                </div>

                <Field label="温度 (0-2)">
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    max={2}
                    value={draft.aiTemperature}
                    onChange={(e) => set("aiTemperature", Number(e.target.value) || 0.7)}
                  />
                  <span className="hint">越高越随机发散，越低越确定保守。</span>
                </Field>

                <Field label="上下文策略">
                  <select
                    value={draft.aiContextStrategy}
                    onChange={(e) =>
                      set("aiContextStrategy", e.target.value as Settings["aiContextStrategy"])
                    }
                  >
                    <option value="standard">标准（开头 6000 字）</option>
                    <option value="large">较大（开头 12000 字）</option>
                    <option value="smart">智能节选（按提问相关度）</option>
                    <option value="full">完整全文（不截断）</option>
                  </select>
                  <span className="hint">
                    长笔记发往模型前的截断方式（省 token）。智能节选为本地算法，
                    保留标题、开头/结尾与和你问题最相关的段落。
                  </span>
                </Field>

                {/* Advanced sampling params — collapsed by default (平滑展开/收起)。 */}
                <button
                  type="button"
                  className="field-collapsible"
                  onClick={() => setShowAdvanced((s) => !s)}
                  aria-expanded={showAdvanced}
                >
                  <ChevronRightIcon size={11} className={`chevron${showAdvanced ? " open" : ""}`} /> 高级参数
                </button>
                <div className={`field-collapse${showAdvanced ? " open" : ""}`}>
                  <Field label="思考强度">
                    <select
                      value={draft.aiThinkingStrength}
                      onChange={(e) =>
                        set("aiThinkingStrength", e.target.value as ThinkingStrength)
                      }
                    >
                      <option value="off">关闭</option>
                      <option value="low">低</option>
                      <option value="medium">中</option>
                      <option value="high">高</option>
                    </select>
                    <span className="hint">
                      仅对推理型模型生效（如 GLM-4.6、OpenAI o 系列、DeepSeek-R1）。
                      按服务商自动适配字段（OpenAI 系/DeepSeek 用 reasoning_effort，
                      智谱/Kimi 用 thinking.budget_tokens），关闭则不发送。
                    </span>
                  </Field>
                  <Field label="对话历史预算 (tokens)">
                    <input
                      type="number"
                      step={500}
                      min={1000}
                      value={draft.aiHistoryBudgetTokens}
                      onChange={(e) =>
                        set("aiHistoryBudgetTokens", Math.max(1000, Number(e.target.value) || 8000))
                      }
                    />
                    <span className="hint">
                      每次请求携带的历史消息 token 上限（本地估算）：超出时从最早
                      的问答对开始丢弃，最近的对话始终完整发送。0 或过小按 8000 处理。
                    </span>
                  </Field>
                  <Field label="批注精炼上限 (字符)">
                    <input
                      type="number"
                      step={500}
                      min={500}
                      value={draft.aiAnnotateMaxChars}
                      onChange={(e) =>
                        set("aiAnnotateMaxChars", Math.max(500, Number(e.target.value) || 4000))
                      }
                    />
                    <span className="hint">
                      把 AI 回复精炼成批注时，发往模型的输入截断上限（0 按默认 4000）。
                    </span>
                  </Field>
                  <Field label="最大输出 tokens (0=不限)">
                    <input
                      type="number"
                      step={64}
                      min={0}
                      value={draft.aiMaxTokens}
                      onChange={(e) => set("aiMaxTokens", Math.max(0, Number(e.target.value) || 0))}
                    />
                    <span className="hint">0 表示不发送该字段，由服务商默认值决定。</span>
                  </Field>
                  <Field label="Top P (0-1)">
                    <input
                      type="number"
                      step="0.05"
                      min={0}
                      max={1}
                      value={draft.aiTopP}
                      onChange={(e) => set("aiTopP", Math.min(1, Math.max(0, Number(e.target.value) || 1)))}
                    />
                    <span className="hint">核采样阈值，与温度二选一调节即可。</span>
                  </Field>
                </div>

                <Field label="自定义系统提示词">
                  <textarea
                    className="mono ai-prompt-area"
                    rows={4}
                    placeholder="留空则使用内置默认提示词（写作助手）。可填入角色设定、语言风格等。"
                    value={draft.aiSystemPrompt}
                    onChange={(e) => set("aiSystemPrompt", e.target.value)}
                  />
                  <span className="hint">
                    会与笔记全文一起作为系统提示；选区操作也以它（或默认）为基础。
                  </span>
                </Field>

                {/* 测试连接针对上方的模型/参数配置，紧随其后（原排在快捷操作之后，
                    与被测对象相隔一个分区，易误解为与快捷操作相关） */}
                <div className="ai-test-row">
                  <button className="btn-ghost" onClick={runTest} disabled={testing}>
                    {testing ? "测试中…" : "测试连接"}
                  </button>
                  {testMsg && <span className={testOk ? "ai-test-ok" : "ai-test-err"}>{testMsg}</span>}
                </div>
              </>
            )}

            {section === 5 && (
              <>
                <span className="hint" style={{ marginTop: -4 }}>
                  作用域「全文」的操作显示在 AI 面板顶部；「选区」操作显示在选中文字的工具条。
                  选区操作的提示词中可用 <code>{"{selection}"}</code> 占位符代表选中内容。
                </span>
                <div className="qa-editor">
                  {qa.map((a, i) => (
                    <div className="qa-row" key={i}>
                      <input
                        className="qa-label"
                        type="text"
                        placeholder="标签"
                        value={a.label}
                        onChange={(e) => updateQa(i, { label: e.target.value })}
                      />
                      <input
                        className="qa-prompt"
                        type="text"
                        placeholder="提示词"
                        value={a.prompt}
                        onChange={(e) => updateQa(i, { prompt: e.target.value })}
                      />
                      <select
                        className="qa-scope"
                        value={a.scope}
                        onChange={(e) => updateQa(i, { scope: e.target.value as QuickActionScope })}
                      >
                        <option value="full">全文</option>
                        <option value="selection">选区</option>
                      </select>
                      <button
                        className="qa-del"
                        type="button"
                        title="删除"
                        onClick={() => removeQa(i)}
                      >
                        <CloseIcon size={11} />
                      </button>
                    </div>
                  ))}
                  <button className="qa-add" type="button" onClick={addQa}>
                    + 添加操作
                  </button>
                </div>
              </>
            )}

            {section === 6 && (
              <>
                <div className="excluded-hint">
                  以下项仅从文件树隐藏，磁盘文件未删除；点「恢复」可在文件树重新显示。
                </div>
                {excluded.length === 0 ? (
                  <div className="excluded-empty">暂无已移除的项目</div>
                ) : (
                  <>
                    <ul className="excluded-list">
                      {excluded.map((p) => (
                        <li key={p} className="excluded-row">
                          <span className="excluded-path" title={p}>
                            {displayPath(p)}
                          </span>
                          <button
                            type="button"
                            className="btn-ghost excluded-restore"
                            onClick={() => restoreExcluded(p)}
                          >
                            恢复
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="btn-ghost" onClick={restoreAllExcluded}>
                      全部恢复
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </section>

        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={applyAll}>应用</button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </label>
  );
}
