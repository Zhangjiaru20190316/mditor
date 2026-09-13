// Settings dialog. Edits the Settings object via useSettings.update.
//
// v4.1: 单列长滚动改为左导航双栏——左列竖排分区导航（激活指示条随切换平滑
// 滑动），右列仅渲染当前分区（切换只重渲染右列相关 Field）；「性能与诊断」
// 从折叠组升为正式导航分区，「高级参数」保留在 AI 分区内折叠。纯 UI 重组
// ——draft/apply 读写流、每项控件与默认值不变（types.test.ts 快照锚定）。
//
// Custom CSS: pick a .css file on disk; we read it and inject it live.

import { useEffect, useState } from "react";
import { getAdapter } from "../platform";
import type {
  AiModelConfig,
  AiProvider,
  MotionLevel,
  QuickAction,
  QuickActionScope,
  Settings,
  SyncSettings,
  Theme,
  ThinkingStrength,
} from "../types";
import {
  AI_PROVIDERS,
  AI_PROVIDER_BY_ID,
  SYNC_PROVIDERS,
  emptyAiModel,
  FONT_PRESETS,
  MONO_FONT_PRESETS,
} from "../types";
import { testConnection } from "../lib/ai";
import {
  SYNC_ERROR_CODES,
  SYNC_ERROR_HINTS,
  isSyncSupported,
  parseSyncError,
  s3TestConnection,
  syncConfigPayload,
} from "../lib/sync/s3";
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
  "知识功能",
  "云同步",
] as const;
/** 云同步分区索引（applyAll 校验失败时聚焦用）。 */
const SYNC_SECTION_IDX = SECTIONS.indexOf("云同步");
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

/** endpoint 是否 localhost HTTP（MinIO 本地调试豁免；与 Rust 侧判定同源）。 */
function isLocalhostEndpoint(endpoint: string): boolean {
  const rest = endpoint.trim().toLowerCase().replace(/^http:\/\//, "");
  if (rest === endpoint.trim().toLowerCase()) return false; // 无 http:// 前缀
  const host = rest.split(/[:/]/)[0] ?? "";
  return host === "localhost" || host === "127.0.0.1";
}

/** 启用同步还缺哪些必填项（AWS 预设可留空 endpoint 走默认端点）。 */
function isSyncIncomplete(s: SyncSettings): boolean {
  return (
    s.bucket.trim() === "" ||
    s.accessKeyId.trim() === "" ||
    s.secretAccessKey === "" ||
    (s.provider !== "aws" && s.endpoint.trim() === "")
  );
}

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
  // 云同步分区状态（v4.12）：连接测试反馈 + SK 明显切换 + 高级折叠。
  const [syncTesting, setSyncTesting] = useState(false);
  const [syncTestMsg, setSyncTestMsg] = useState("");
  const [syncTestOk, setSyncTestOk] = useState(false);
  const [showSk, setShowSk] = useState(false);
  const [showSyncAdvanced, setShowSyncAdvanced] = useState(false);
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
    const p = await getAdapter().dialog.pickOpenFile([
      { name: "CSS", extensions: ["css"] },
    ]);
    if (typeof p === "string") set("customCssPath", p);
  };

  // v4.7 模块 3：文献库 .bib 选择（知识功能分组）。
  const pickBib = async () => {
    const p = await getAdapter().dialog.pickOpenFile([
      { name: "BibTeX", extensions: ["bib", "txt"] },
    ]);
    if (typeof p === "string") set("bibliographyPath", p);
  };

  const applyAll = async () => {
    // 云同步保存校验（v4.12）：非 localhost 的 HTTP endpoint 一律阻断；
    // enabled 但信息不全时聚焦本分区提示补全（不关闭弹窗）。
    const sync = draft.sync;
    if (sync.enabled) {
      if (/^http:\/\//i.test(sync.endpoint.trim()) && !isLocalhostEndpoint(sync.endpoint)) {
        setSection(SYNC_SECTION_IDX);
        setSyncTestOk(false);
        setSyncTestMsg("仅允许 HTTPS endpoint（HTTP 仅限 localhost/127.0.0.1 本地调试）");
        return;
      }
      if (isSyncIncomplete(sync)) {
        setSection(SYNC_SECTION_IDX);
        setSyncTestOk(false);
        setSyncTestMsg("信息不全：请补全桶名、AccessKey / SecretKey（AWS 预设可留空 endpoint）");
        return;
      }
    }
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

  // ---- 云同步（v4.12）----------------------------------------------------

  const syncSupported = isSyncSupported();
  const setSync = (patch: Partial<SyncSettings>) =>
    setDraft((d) => ({ ...d, sync: { ...d.sync, ...patch } }));

  /** 预设切换：endpoint/region 仅空值预填（不粗暴覆盖已填值）；寻址风格
   *  属预设语义本身，随预设切换（高级折叠里可再改）。 */
  const pickSyncProvider = (id: string) => {
    const preset = SYNC_PROVIDERS.find((p) => p.id === id);
    if (!preset) return;
    setDraft((d) => ({
      ...d,
      sync: {
        ...d.sync,
        provider: id,
        endpoint: d.sync.endpoint.trim() === "" ? (preset.endpointTemplate ?? "") : d.sync.endpoint,
        region:
          d.sync.region.trim() === "" && id === "cloudflare-r2" ? "auto" : d.sync.region,
        pathStyle: preset.pathStyleDefault,
      },
    }));
  };

  /** 测试连接基于 draft（与 AI 测试连接同一先例：不落盘、不代保存）。 */
  const runSyncTest = async () => {
    if (!syncSupported) return;
    setSyncTesting(true);
    setSyncTestMsg("");
    try {
      const info = await s3TestConnection(syncConfigPayload(draft.sync));
      setSyncTestOk(true);
      setSyncTestMsg(`连接成功：${info.bucket}（${info.region}）`);
    } catch (e) {
      const { code, message } = parseSyncError(e);
      setSyncTestOk(false);
      setSyncTestMsg(`${SYNC_ERROR_HINTS[code] ?? SYNC_ERROR_HINTS[SYNC_ERROR_CODES.UNKNOWN]}（${message}）`);
    } finally {
      setSyncTesting(false);
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

                <Field label="公式自动编号">
                  <input
                    type="checkbox"
                    checked={draft.mathAutoNumber}
                    onChange={(e) => set("mathAutoNumber", e.target.checked)}
                  />
                  <span className="hint">
                    {
                      "展示公式（$$…$$）在 AI 面板、批注预览与导出（HTML/PDF/Word/复制富文本）中按出现顺序自动编号，\\label 收集、\\ref/\\eqref 解析为编号；带 \\tag 或 \\notag 的公式保持作者定义。编辑器内不做实时编号（\\tag{} 手动可用）。"
                    }
                  </span>
                </Field>

                <Field label="KaTeX 宏定义 (JSON)">
                  <textarea
                    rows={3}
                    spellCheck={false}
                    placeholder={'{"\\\\RR": "\\\\mathbb{R}"}'}
                    value={draft.mathMacros}
                    onChange={(e) => set("mathMacros", e.target.value)}
                    style={{
                      width: "100%",
                      fontFamily: "var(--font-mono, monospace)",
                      resize: "vertical",
                    }}
                  />
                  <span className="hint">
                    {
                      '自定义宏展开，如 {"\\RR": "\\mathbb{R}"}（键可省略反斜杠）。写入公式源码时用 \\RR 即可；格式非法时忽略并沿用空宏。修改后自动重建编辑器（撤销历史清空）；行内公式在编辑器内暂不应用宏。'
                    }
                  </span>
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
                <Field label="大文档视口渲染">
                  <input
                    type="checkbox"
                    checked={draft.bigDocViewport}
                    onChange={(e) => set("bigDocViewport", e.target.checked)}
                  />
                  <span className="hint">
                    与上面的减配解耦：文档超过 3000 行或 500KB
                    时只对视口外内容跳过布局与绘制（content-visibility），
                    保留代码高亮与公式渲染。适合公式/代码密集的大文档——
                    拖选、三击选段、点击公式等交互在超大文档上可从秒级卡顿
                    降到无感。切换后当前文档会自动重建编辑器（撤销历史清空）。
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

                {/* v4.9 Agent 小节：模式说明 + 写入策略（模式本身在 AI 面板顶部切换）。 */}
                <div className="field-section">Agent</div>
                <Field label="Agent 写入策略">
                  <select
                    value={draft.agentWriteMode}
                    onChange={(e) =>
                      set("agentWriteMode", e.target.value as Settings["agentWriteMode"])
                    }
                  >
                    <option value="confirm">逐条确认（默认）</option>
                    <option value="auto">自动应用当前笔记编辑</option>
                  </select>
                  <span className="hint">
                    Agent 模式（AI 面板顶部「对话 | Agent」切换）下改动的落地方式。
                    「自动」仅对当前笔记的内容编辑（编辑/追加）在循环结束后直接应用
                    （Ctrl+Z 可一步撤销）；其他文件与文件系统操作（新建/重命名/删除）
                    无论如何都要经「改动清单」审阅确认，删除一律进系统回收站（可恢复）。
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

            {section === 7 && (
              <>
                <Field label="全库索引">
                  <input
                    type="checkbox"
                    checked={draft.vaultIndexEnabled}
                    onChange={(e) => set("vaultIndexEnabled", e.target.checked)}
                  />
                  <span className="hint">
                    扫描工作区全部 Markdown 文件，维护本地索引（标题 / 双向链接 /
                    标签），供 Ctrl+P 快速打开、反向链接面板、标签过滤与复习功能
                    复用。纯本地运行、不联网、不落盘；扫描在空闲时段分批进行，
                    保存时只增量更新当前文件。
                  </span>
                </Field>
                <Field label="双向链接">
                  <input
                    type="checkbox"
                    checked={draft.wikiLinksEnabled}
                    onChange={(e) => set("wikiLinksEnabled", e.target.checked)}
                  />
                  <span className="hint">
                    [[笔记名]] / [[笔记名|显示文本]] 双链语法：输入 [[ 弹出补全、
                    点击跳转、侧栏「链接」页查看反向链接与标签。语法解析本身恒
                    开启（保证文件互通），此开关只控制交互功能；导出时双链自动
                    降级为标准链接或纯文本。
                  </span>
                </Field>
                <Field label="文献库 (.bib)">
                  <span className="bib-path-row">
                    <input
                      className="bib-path-input"
                      type="text"
                      placeholder="选择 Zotero / Better BibTeX 导出的 .bib 文件"
                      value={draft.bibliographyPath}
                      onChange={(e) => set("bibliographyPath", e.target.value)}
                    />
                    <button type="button" className="btn-ghost" onClick={pickBib}>
                      浏览…
                    </button>
                  </span>
                  <span className="hint">
                    配置后启用学术引用：[@citekey] 行内引用（选区工具栏「引用」
                    插入）、文末 # References 标题下自动生成文献表、LaTeX 导出
                    的 \cite / thebibliography。文件仅本地读取，坏条目自动跳过。
                  </span>
                </Field>
                <Field label="引用样式">
                  <select
                    value={draft.citationStyle}
                    onChange={(e) =>
                      set("citationStyle", e.target.value as "numeric" | "author-year")
                    }
                  >
                    <option value="numeric">编号 [1]</option>
                    <option value="author-year">作者-年份 (APA)</option>
                  </select>
                  <span className="hint">
                    编号样式按正文首次引用顺序生成文献表；作者-年份样式按第一
                    作者字母序（APA）。编辑器内引用 chip 统一显示作者-年份形态，
                    最终形态以静态渲染与导出为准。
                  </span>
                </Field>
                <Field label="间隔重复闪卡">
                  <input
                    type="checkbox"
                    checked={draft.flashcardsEnabled}
                    onChange={(e) => set("flashcardsEnabled", e.target.checked)}
                  />
                  <span className="hint">
                    :::flash 问答卡（选区工具栏「卡」手动做卡 / AI 菜单「改写为
                    问答卡」），SM-2 简化调度（间隔表 0/1/3/7/14/30 天 × ease 因
                    子）。进度只存本地 appDataDir/review-state.json；语法解析恒开
                    启，此开关控制复习入口与做卡按钮；导出时闪卡降级为引用块。
                  </span>
                </Field>
                <Field label="全库问答 (RAG)">
                  <input
                    type="checkbox"
                    checked={draft.ragEnabled}
                    onChange={(e) => set("ragEnabled", e.target.checked)}
                  />
                  <span className="hint">
                    对整个笔记库提问（AI 面板「全库问答」开关）：问题嵌入 → 余弦
                    检索 top-8 → 带来源回答。默认关闭——构建索引会调用嵌入 API
                    产生费用（首次构建有成本确认提示）；向量索引只存本地
                    appDataDir/rag-index.json，嵌入请求经应用内代理（渲染层不直
                    连外网）。
                  </span>
                </Field>
                {draft.ragEnabled && (
                  <>
                    <Field label="嵌入 Base URL">
                      <input
                        type="text"
                        placeholder="https://api.openai.com/v1"
                        value={draft.ragEmbedBaseUrl}
                        onChange={(e) => set("ragEmbedBaseUrl", e.target.value)}
                      />
                      <span className="hint">
                        OpenAI 兼容 /embeddings 端点的 Base URL（独立于对话模型；
                        留空表示未启用）。
                      </span>
                    </Field>
                    <Field label="嵌入 API Key">
                      <input
                        type="password"
                        placeholder="sk-…（本地服务可留空）"
                        value={draft.ragEmbedApiKey}
                        onChange={(e) => set("ragEmbedApiKey", e.target.value)}
                      />
                    </Field>
                    <Field label="嵌入模型">
                      <input
                        type="text"
                        placeholder="text-embedding-3-small"
                        value={draft.ragEmbedModel}
                        onChange={(e) => set("ragEmbedModel", e.target.value)}
                      />
                      <span className="hint">
                        更换模型后索引自动全量重建（向量语义空间不兼容）。
                      </span>
                    </Field>
                  </>
                )}
              </>
            )}

            {section === SYNC_SECTION_IDX && (
              <>
                {/* 鸿蒙运行时：整分区禁用 + 固定提示条（§7.5.3，不渲染成错误态）。 */}
                {!syncSupported && (
                  <div className="sync-unsupported">云同步当前仅支持桌面版</div>
                )}
                <span className="hint" style={{ marginTop: syncSupported ? -4 : 0 }}>
                  可选的「自带存储」云同步：把工作区目录双向同步到你自己的 S3 兼容
                  对象存储（七牛 / 阿里 OSS / R2 / MinIO / AWS 等）。默认关闭、不开
                  即零网络；不引入任何厂商绑定或中转服务。
                </span>

                <Field label="启用云同步">
                  <input
                    type="checkbox"
                    disabled={!syncSupported}
                    checked={draft.sync.enabled}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setSync({ enabled: on });
                      // 信息不全时开启：留在本分区并提示补全（不阻断开关本身，
                      // 应用时 applyAll 会再次校验）。
                      if (on && isSyncIncomplete(draft.sync)) {
                        setSyncTestOk(false);
                        setSyncTestMsg("信息不全：请补全服务商、桶名与访问凭证后再应用");
                      }
                    }}
                  />
                  <span className="hint">
                    开启后仅在你手动/自动触发同步时访问你配置的单桶单前缀。
                  </span>
                </Field>

                <Field label="服务商">
                  <select
                    disabled={!syncSupported}
                    value={draft.sync.provider}
                    onChange={(e) => pickSyncProvider(e.target.value)}
                  >
                    {SYNC_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    预设只负责预填 endpoint / region / 寻址风格，均以各厂商控制台
                    实际信息为准，可随时手改。
                  </span>
                </Field>

                <Field label="Endpoint">
                  <input
                    type="text"
                    className="mono"
                    disabled={!syncSupported}
                    placeholder={
                      draft.sync.provider === "aws"
                        ? "可留空 = AWS 默认端点"
                        : "https://…（模板中的 {region}/{accountId} 请替换为实际值）"
                    }
                    value={draft.sync.endpoint}
                    onChange={(e) => setSync({ endpoint: e.target.value })}
                  />
                </Field>

                <Field label="Region">
                  <input
                    type="text"
                    className="mono"
                    disabled={!syncSupported}
                    placeholder={
                      SYNC_PROVIDERS.find((p) => p.id === draft.sync.provider)?.regionHint ??
                      "us-east-1"
                    }
                    value={draft.sync.region}
                    onChange={(e) => setSync({ region: e.target.value })}
                  />
                </Field>

                <Field label="Bucket（桶名）">
                  <input
                    type="text"
                    className="mono"
                    disabled={!syncSupported}
                    placeholder="my-notes"
                    value={draft.sync.bucket}
                    onChange={(e) => setSync({ bucket: e.target.value })}
                  />
                </Field>

                <Field label="AccessKey ID">
                  <input
                    type="text"
                    className="mono"
                    disabled={!syncSupported}
                    placeholder="仅限该桶的最小权限子账号"
                    value={draft.sync.accessKeyId}
                    onChange={(e) => setSync({ accessKeyId: e.target.value })}
                  />
                </Field>

                <Field label="Secret Access Key">
                  <span className="sync-sk-row">
                    <input
                      type={showSk ? "text" : "password"}
                      className="mono"
                      disabled={!syncSupported}
                      value={draft.sync.secretAccessKey}
                      onChange={(e) => setSync({ secretAccessKey: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={!syncSupported}
                      onClick={() => setShowSk((v) => !v)}
                    >
                      {showSk ? "隐藏" : "显示"}
                    </button>
                  </span>
                  <span className="hint sync-secret-hint">
                    密钥以明文保存在本机 mditor.json，建议使用仅限该桶的最小权限
                    子账号；远端删除不可恢复，建议为该桶开启版本控制。
                  </span>
                </Field>

                <Field label="同步前缀">
                  <input
                    type="text"
                    className="mono"
                    disabled={!syncSupported}
                    placeholder="mditor/"
                    value={draft.sync.prefix}
                    onChange={(e) => setSync({ prefix: e.target.value })}
                  />
                  <span className="hint">
                    每个工作区根同步到「前缀/根目录名/」下；留空则直接位于根目录名
                    下。保存时自动规范化（不以 / 开头、以 / 结尾）。
                  </span>
                </Field>

                <button
                  type="button"
                  className="field-collapsible"
                  disabled={!syncSupported}
                  onClick={() => setShowSyncAdvanced((s) => !s)}
                  aria-expanded={showSyncAdvanced}
                >
                  <ChevronRightIcon size={11} className={`chevron${showSyncAdvanced ? " open" : ""}`} /> 高级选项
                </button>
                <div className={`field-collapse${showSyncAdvanced ? " open" : ""}`}>
                  <Field label="Path-style 寻址">
                    <input
                      type="checkbox"
                      disabled={!syncSupported}
                      checked={draft.sync.pathStyle}
                      onChange={(e) => setSync({ pathStyle: e.target.checked })}
                    />
                    <span className="hint">
                      MinIO / Cloudflare R2 推荐开启；七牛 / 阿里 / AWS 默认关闭
                      （virtual-hosted 风格）。
                    </span>
                  </Field>
                  <Field label="自动同步">
                    <input
                      type="checkbox"
                      disabled={!syncSupported}
                      checked={draft.sync.autoSync}
                      onChange={(e) => setSync({ autoSync: e.target.checked })}
                    />
                    <span className="hint">保存后 5 秒防抖触发 + 按下述间隔定时。</span>
                  </Field>
                  <Field label="定时间隔（分钟，0=关闭）">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      disabled={!syncSupported}
                      value={draft.sync.autoSyncIntervalMin}
                      onChange={(e) =>
                        setSync({ autoSyncIntervalMin: Math.max(0, Number(e.target.value) || 0) })
                      }
                    />
                  </Field>
                  <Field label="启动时同步">
                    <input
                      type="checkbox"
                      disabled={!syncSupported}
                      checked={draft.sync.syncOnStart}
                      onChange={(e) => setSync({ syncOnStart: e.target.checked })}
                    />
                    <span className="hint">应用启动 15 秒后自动同步一次（避开启动竞争）。</span>
                  </Field>
                </div>

                <div className="ai-test-row">
                  <button
                    className="btn-ghost"
                    onClick={runSyncTest}
                    disabled={!syncSupported || syncTesting}
                  >
                    {syncTesting ? "测试中…" : "测试连接"}
                  </button>
                  {syncTestMsg && (
                    <span className={syncTestOk ? "ai-test-ok" : "ai-test-err"}>
                      {syncTestMsg}
                    </span>
                  )}
                </div>
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
