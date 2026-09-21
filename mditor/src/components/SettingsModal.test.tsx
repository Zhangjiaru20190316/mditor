// @vitest-environment jsdom
// SettingsModal 组件测试（第五批 Q11 组件测试扩展·第一站：设置弹窗）。
// 范式沿用 QuickSwitcher / FileTree（N19/N21）：
//   * vitest globals 未开——API 一律显式 import 自 "vitest"；
//   * 平台层 mock：vi.mock("../platform") 同时拦截 SettingsModal 的
//     getAdapter（dialog.pickOpenFile / app.invoke）与 lib/sync/s3 的
//     detectRuntime（固定 "tauri" → isSyncSupported()=true，云同步分区
//     控件可用；jsdom 真实 detectRuntime 会判 browser 导致整分区禁用）。
//     adapter 夹具经 vi.hoisted 提升供工厂引用（TDZ 规避）；
//   * 网络依赖 mock：../lib/ai 的 testConnection、../lib/appVersion 的
//     fetchAppVersion。纯逻辑一律真实运行——types 的 DEFAULT_SETTINGS /
//     FONT_PRESETS / SYNC_PROVIDERS、s3 的 syncConfigPayload（trim + region
//     兜底）/ parseSyncError / SYNC_ERROR_HINTS 全走真实实现；
//   * RTL v16 在无全局 afterEach 的框架里不自动 cleanup——显式调用；
//   * Field 的 <label> 会包住 hint 文案（getByLabelText 全串匹配不可靠），
//     表单控件经 .field-label 精确文本定位（control() 助手）；按钮/文案
//     断言仍走 getByRole / getByText。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Settings } from "../types";
import { testConnection } from "../lib/ai";
import { fetchAppVersion } from "../lib/appVersion";

// 平台层夹具：adapter 只实现 SettingsModal 触碰的面（dialog / app.invoke）。
const { ADAPTER } = vi.hoisted(() => ({
  ADAPTER: {
    dialog: { pickOpenFile: vi.fn() },
    app: { invoke: vi.fn() },
  },
}));

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri" as const,
  getAdapter: () => ADAPTER,
}));

vi.mock("../lib/ai", () => ({ testConnection: vi.fn() }));
vi.mock("../lib/appVersion", () => ({ fetchAppVersion: vi.fn(async () => "9.9.9-test") }));

/** 以真实 DEFAULT_SETTINGS 为底克隆一份可覆写的设置。 */
function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    aiModels: DEFAULT_SETTINGS.aiModels.map((m) => ({ ...m })),
    aiQuickActions: DEFAULT_SETTINGS.aiQuickActions.map((a) => ({ ...a })),
    sync: { ...DEFAULT_SETTINGS.sync },
    excludedPaths: [],
    ...overrides,
  };
}

interface Mounted {
  onClose: Mock<() => void>;
  onChange: Mock<(patch: Partial<Settings>) => Promise<void>>;
  view: ReturnType<typeof render>;
}

/** 挂载打开态 SettingsModal，回调为 mock。 */
function renderModal(settings: Settings = baseSettings(), workspace?: string): Mounted {
  const onClose = vi.fn<() => void>();
  const onChange = vi.fn<(patch: Partial<Settings>) => Promise<void>>(async () => undefined);
  const view = render(
    <SettingsModal
      open
      settings={settings}
      workspace={workspace ?? null}
      onClose={onClose}
      onChange={onChange}
    />
  );
  return { onClose, onChange, view };
}

/** 点左侧分区导航。 */
const gotoSection = (label: string) =>
  fireEvent.click(screen.getByRole("button", { name: label }));

/** 按 field-label 精确文本取 Field 内的表单控件（input/select/textarea）。 */
function control<T extends HTMLElement = HTMLElement>(label: string): T {
  const fields = [...document.querySelectorAll<HTMLLabelElement>(".field")];
  const hit = fields.find((f) => f.querySelector(".field-label")?.textContent === label);
  if (!hit) throw new Error(`Field "${label}" 未渲染`);
  const el = hit.querySelector<T>("input, select, textarea");
  if (!el) throw new Error(`Field "${label}" 无表单控件`);
  return el;
}

const clickApply = () => fireEvent.click(screen.getByRole("button", { name: "应用" }));
/** 「应用」提交给 onChange 的整份 draft。 */
const appliedDraft = (m: Mounted) => m.onChange.mock.calls[0][0] as Settings;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("SettingsModal", () => {
  it("打开渲染 dialog + 10 项分区导航，仅渲染当前分区（默认外观）", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "设置分区" });
    expect(nav.querySelectorAll(".settings-nav-btn")).toHaveLength(10);
    // 默认分区 0（外观）：aria-current + 指示条 translateY(0)。
    expect(screen.getByRole("button", { name: "外观" })).toHaveAttribute("aria-current", "true");
    const ind = nav.querySelector<HTMLElement>(".settings-nav-ind")!;
    expect(ind.style.transform).toBe("translateY(0px)");
    // 右列只渲染当前分区：主题在、排版的字段不在。
    expect(control("主题")).toBeInTheDocument();
    expect(screen.queryByText("正文字号 (px)")).not.toBeInTheDocument();
  });

  it("切换分区：pane 重渲染、aria-current 与指示条随索引滑动", () => {
    renderModal();
    const ind = document.querySelector<HTMLElement>(".settings-nav-ind")!;
    gotoSection("排版");
    expect(screen.getByRole("button", { name: "排版" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "外观" })).not.toHaveAttribute("aria-current");
    expect(control("正文字号 (px)")).toBeInTheDocument();
    expect(screen.queryByText("主题")).not.toBeInTheDocument();
    expect(ind.style.transform).toBe("translateY(38px)"); // 1 * (34 + 4)
    gotoSection("云同步");
    expect(control("Endpoint")).toBeInTheDocument();
    expect(ind.style.transform).toBe("translateY(304px)"); // 8 * 38
  });

  it("主题下拉 + 动效单选改值 → 应用提交 draft 并关闭", async () => {
    const m = renderModal();
    fireEvent.change(control("主题"), { target: { value: "dark" } });
    // role="radio" 的可访问名来自 author（ARIA 规定，内容不算名）——按文本定位按钮本体。
    const none = screen.getByText("无");
    fireEvent.click(none);
    expect(none).toHaveAttribute("aria-checked", "true");
    clickApply();
    expect(m.onChange).toHaveBeenCalledTimes(1);
    const draft = appliedDraft(m);
    expect(draft.theme).toBe("dark");
    expect(draft.motionLevel).toBe("none");
    await waitFor(() => expect(m.onClose).toHaveBeenCalledTimes(1));
  });

  it("字体预设耦合：选预设写入字体栈，手改字体栈切回「自定义」", () => {
    const m = renderModal();
    const preset = control<HTMLSelectElement>("字体预设");
    fireEvent.change(preset, { target: { value: "wenkai" } });
    const stack = control<HTMLInputElement>("正文字体栈");
    expect(stack.value).toContain("LXGW WenKai"); // 真实 FONT_PRESETS 栈写入
    fireEvent.change(stack, { target: { value: "Custom, serif" } });
    expect(preset.value).toBe(""); // fontPreset 置空 = 自定义
    clickApply();
    const draft = appliedDraft(m);
    expect(draft.fontPreset).toBe("");
    expect(draft.fontFamily).toBe("Custom, serif");
  });

  it("编辑行为：拼写检查开关、KaTeX 宏原文透传、自动保存非法输入回退 0", () => {
    const m = renderModal();
    gotoSection("编辑行为");
    const spell = control<HTMLInputElement>("拼写检查");
    expect(spell.checked).toBe(true); // 默认开
    fireEvent.click(spell);
    expect(spell.checked).toBe(false);
    fireEvent.change(control<HTMLTextAreaElement>("KaTeX 宏定义 (JSON)"), {
      target: { value: '{"RR": "\\mathbb{R}"}' },
    });
    // 非数字输入 → Number(...) 为 NaN → || 0 兜底为 0（关闭）。
    fireEvent.change(control<HTMLInputElement>("自动保存间隔 (毫秒, 0=关闭)"), {
      target: { value: "abc" },
    });
    clickApply();
    const draft = appliedDraft(m);
    expect(draft.spellcheck).toBe(false);
    expect(draft.mathMacros).toBe('{"RR": "\\mathbb{R}"}');
    expect(draft.autosaveIntervalMs).toBe(0);
  });

  it("性能与诊断：关闭内存自动优化后阈值输入禁用，其余开关写入 draft", () => {
    const m = renderModal();
    gotoSection("性能与诊断");
    const threshold = control<HTMLInputElement>("内存优化阈值 (MB)");
    expect(threshold.disabled).toBe(false);
    fireEvent.click(control<HTMLInputElement>("内存自动优化"));
    expect(threshold.disabled).toBe(true); // 联动禁用
    fireEvent.click(control<HTMLInputElement>("批注诊断面板"));
    clickApply();
    const draft = appliedDraft(m);
    expect(draft.memoryGuard).toBe(false);
    expect(draft.annoDiagPanel).toBe(true);
  });

  it("AI 助手：provider 预填 baseUrl/默认模型（已有模型名不覆盖），删唯一行禁用", () => {
    renderModal();
    gotoSection("AI 助手");
    const rows = () => [...document.querySelectorAll<HTMLElement>(".model-row")];
    expect(rows()).toHaveLength(1);
    // 唯一行删除按钮禁用（至少保留一个模型）。
    expect(rows()[0].querySelector<HTMLButtonElement>(".model-del")!.disabled).toBe(true);
    // 选 DeepSeek 预设：模型名为空时预填默认值（先清空默认行已有的 gpt-4o-mini）。
    const providerSel = rows()[0].querySelector<HTMLSelectElement>(".model-provider")!;
    fireEvent.change(rows()[0].querySelector<HTMLInputElement>(".model-name-id")!, {
      target: { value: "" },
    });
    fireEvent.change(providerSel, { target: { value: "deepseek" } });
    expect(rows()[0].querySelector<HTMLInputElement>(".model-baseurl")!.value).toBe(
      "https://api.deepseek.com/v1"
    );
    expect(rows()[0].querySelector<HTMLInputElement>(".model-name-id")!.value).toBe(
      "deepseek-chat"
    );
    // 手改模型名后再换预设：模型名保留（仅空值预填）。
    fireEvent.change(providerSel, { target: { value: "custom" } });
    fireEvent.change(rows()[0].querySelector<HTMLInputElement>(".model-name-id")!, {
      target: { value: "my-model" },
    });
    fireEvent.change(providerSel, { target: { value: "openai" } });
    expect(rows()[0].querySelector<HTMLInputElement>(".model-name-id")!.value).toBe("my-model");
    expect(rows()[0].querySelector<HTMLInputElement>(".model-baseurl")!.value).toBe(
      "https://api.openai.com/v1"
    );
  });

  it("AI 助手：添加模型、切换激活、删除激活行后 activeId 重指剩余行", () => {
    const m = renderModal();
    gotoSection("AI 助手");
    const rows = () => [...document.querySelectorAll<HTMLElement>(".model-row")];
    fireEvent.click(screen.getByRole("button", { name: "+ 添加模型" }));
    expect(rows()).toHaveLength(2);
    const row0Radio = rows()[0].querySelector<HTMLInputElement>("input[type=radio]")!;
    const row1Radio = rows()[1].querySelector<HTMLInputElement>("input[type=radio]")!;
    expect(row0Radio.checked).toBe(true); // 默认模型初始激活
    fireEvent.click(row1Radio);
    expect(row1Radio.checked).toBe(true);
    expect(row0Radio.checked).toBe(false);
    // 删除当前激活的第二行 → activeId 重指剩余第一行。
    fireEvent.click(rows()[1].querySelector<HTMLButtonElement>(".model-del")!);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector<HTMLInputElement>("input[type=radio]")!.checked).toBe(true);
    clickApply();
    const draft = appliedDraft(m);
    expect(draft.aiModels).toHaveLength(1);
    expect(draft.aiActiveModelId).toBe(draft.aiModels[0].id);
  });

  it("AI 测试连接：成功/失败反馈，且不落盘（onChange 不被调用）", async () => {
    const m = renderModal();
    gotoSection("AI 助手");
    vi.mocked(testConnection).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(screen.getByText("连接成功")).toBeInTheDocument());
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(vi.mocked(testConnection).mock.calls[0][0]).toMatchObject({ aiBaseUrl: DEFAULT_SETTINGS.aiBaseUrl });
    vi.mocked(testConnection).mockRejectedValueOnce(new Error("HTTP 401"));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(screen.getByText("Error: HTTP 401")).toBeInTheDocument());
    expect(m.onChange).not.toHaveBeenCalled(); // 测试连接绝不代保存
  });

  it("高级参数折叠展开，数值钳制（历史预算下限 1000 / TopP 上限 1）", () => {
    const m = renderModal();
    gotoSection("AI 助手");
    const adv = screen.getByRole("button", { name: /高级参数/ });
    expect(adv).toHaveAttribute("aria-expanded", "false");
    // 折叠是 CSS 类驱动（.field-collapse 无 open 时收起），字段本身保持挂载。
    const collapse = document.querySelector<HTMLElement>(".field-collapse")!;
    expect(collapse.className).not.toContain("open");
    fireEvent.click(adv);
    expect(adv).toHaveAttribute("aria-expanded", "true");
    expect(collapse.className).toContain("open");
    const hist = control<HTMLInputElement>("对话历史预算 (tokens)");
    fireEvent.change(hist, { target: { value: "500" } }); // Math.max(1000, …)
    expect(hist.value).toBe("1000");
    const topP = control<HTMLInputElement>("Top P (0-1)");
    fireEvent.change(topP, { target: { value: "5" } }); // Math.min(1, Math.max(0, …))
    expect(topP.value).toBe("1");
    clickApply();
    expect(appliedDraft(m).aiHistoryBudgetTokens).toBe(1000);
  });

  it("快捷操作：添加（默认「新操作」）、改作用域、删除首行后 draft 同步", () => {
    const m = renderModal();
    gotoSection("快捷操作");
    const rows = () => [...document.querySelectorAll<HTMLElement>(".qa-row")];
    const initial = rows().length; // 默认 7 条
    fireEvent.click(screen.getByRole("button", { name: "+ 添加操作" }));
    expect(rows()).toHaveLength(initial + 1);
    const newRow = rows()[initial];
    expect(newRow.querySelector<HTMLInputElement>(".qa-label")!.value).toBe("新操作");
    fireEvent.change(newRow.querySelector<HTMLSelectElement>(".qa-scope")!, {
      target: { value: "selection" },
    });
    fireEvent.click(rows()[0].querySelector<HTMLButtonElement>(".qa-del")!); // 删「总结全文」
    expect(rows()).toHaveLength(initial);
    clickApply();
    const draft = appliedDraft(m);
    expect(draft.aiQuickActions).toHaveLength(initial);
    expect(draft.aiQuickActions[0].label).toBe("润色全文"); // 首行已删
  });

  it("工作区：排除路径相对显示、单项恢复、全部恢复后空态", () => {
    const settings = baseSettings({
      excludedPaths: ["C:/ws/secret.md", "C:/ws/notes/draft.md", "D:/other.md"],
    });
    const m = renderModal(settings, "C:/ws");
    gotoSection("工作区");
    expect(screen.getByText("secret.md")).toBeInTheDocument(); // 工作区内 → 相对
    expect(screen.getByText("notes/draft.md")).toBeInTheDocument();
    expect(screen.getByText("D:/other.md")).toBeInTheDocument(); // 工作区外 → 原样
    const rowsEls = () => [...document.querySelectorAll<HTMLElement>(".excluded-row")];
    fireEvent.click(rowsEls()[1].querySelector<HTMLButtonElement>("button")!); // 恢复 draft.md
    expect(rowsEls()).toHaveLength(2);
    expect(screen.queryByText("notes/draft.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部恢复" }));
    expect(screen.getByText("暂无已移除的项目")).toBeInTheDocument();
    clickApply();
    expect(appliedDraft(m).excludedPaths).toEqual([]);
  });

  it("知识功能：RAG 开关联动嵌入字段显隐，引用样式切换，.bib 浏览走 adapter", async () => {
    const m = renderModal();
    gotoSection("知识功能");
    expect(screen.queryByText("嵌入 Base URL")).not.toBeInTheDocument(); // 默认关
    fireEvent.click(control<HTMLInputElement>("全库问答 (RAG)"));
    expect(screen.getByText("嵌入 Base URL")).toBeInTheDocument();
    fireEvent.change(control<HTMLSelectElement>("引用样式"), { target: { value: "author-year" } });
    ADAPTER.dialog.pickOpenFile.mockResolvedValueOnce("C:/refs.bib");
    fireEvent.click(screen.getByRole("button", { name: "浏览…" }));
    await waitFor(() => expect(control<HTMLInputElement>("文献库 (.bib)").value).toBe("C:/refs.bib"));
    expect(ADAPTER.dialog.pickOpenFile).toHaveBeenCalledWith([
      { name: "BibTeX", extensions: ["bib", "txt"] },
    ]);
    clickApply();
    const draft = appliedDraft(m);
    expect(draft.ragEnabled).toBe(true);
    expect(draft.citationStyle).toBe("author-year");
    expect(draft.bibliographyPath).toBe("C:/refs.bib");
  });

  it("自定义 CSS：浏览按钮走 adapter（CSS 过滤器），取消选择不改值", async () => {
    const m = renderModal();
    ADAPTER.dialog.pickOpenFile.mockResolvedValueOnce(undefined); // 对话框取消
    fireEvent.click(screen.getByRole("button", { name: "浏览…" }));
    await waitFor(() =>
      expect(ADAPTER.dialog.pickOpenFile).toHaveBeenCalledWith([
        { name: "CSS", extensions: ["css"] },
      ])
    );
    expect(control<HTMLInputElement>("自定义 CSS 文件").value).toBe("");
    ADAPTER.dialog.pickOpenFile.mockResolvedValueOnce("C:/theme.css");
    fireEvent.click(screen.getByRole("button", { name: "浏览…" }));
    await waitFor(() => expect(control<HTMLInputElement>("自定义 CSS 文件").value).toBe("C:/theme.css"));
    clickApply();
    expect(appliedDraft(m).customCssPath).toBe("C:/theme.css");
  });

  it("云同步保存校验：信息不全/HTTP endpoint 阻断并跳回云同步分区，localhost 豁免放行", async () => {
    const m = renderModal();
    gotoSection("云同步");
    // 启用即提示补全（不阻断开关本身）。
    fireEvent.click(control<HTMLInputElement>("启用云同步"));
    expect(screen.getByText("信息不全：请补全服务商、桶名与访问凭证后再应用")).toBeInTheDocument();
    // 切走分区后应用 → 阻断 + 自动聚焦云同步分区。
    gotoSection("外观");
    clickApply();
    expect(m.onChange).not.toHaveBeenCalled();
    expect(m.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "云同步" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText(/请补全桶名、AccessKey \/ SecretKey/)).toBeInTheDocument();
    // 补全凭证但非 localhost 的 HTTP endpoint → 阻断。
    fireEvent.change(control<HTMLInputElement>("Bucket（桶名）"), { target: { value: "notes" } });
    fireEvent.change(control<HTMLInputElement>("AccessKey ID"), { target: { value: "ak" } });
    fireEvent.change(control<HTMLInputElement>("Secret Access Key"), { target: { value: "sk" } });
    fireEvent.change(control<HTMLInputElement>("Endpoint"), {
      target: { value: "http://storage.example.com" },
    });
    clickApply();
    expect(m.onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/仅允许 HTTPS endpoint/)).toBeInTheDocument();
    // localhost HTTP 豁免（MinIO 本地调试）→ 放行。
    fireEvent.change(control<HTMLInputElement>("Endpoint"), {
      target: { value: "http://localhost:9000" },
    });
    clickApply();
    expect(m.onChange).toHaveBeenCalledTimes(1);
    expect(appliedDraft(m).sync).toMatchObject({ enabled: true, bucket: "notes" });
    await waitFor(() => expect(m.onClose).toHaveBeenCalledTimes(1));
  });

  it("云同步：预设预填 endpoint 模板，占位符在保存与测试连接双侧阻断", async () => {
    const m = renderModal();
    gotoSection("云同步");
    fireEvent.change(control<HTMLSelectElement>("服务商"), { target: { value: "aliyun-oss" } });
    // 空 endpoint 被预设模板预填（含 {region} 占位符）。
    expect(control<HTMLInputElement>("Endpoint").value).toBe("https://oss-{region}.aliyuncs.com");
    fireEvent.click(control<HTMLInputElement>("启用云同步"));
    fireEvent.change(control<HTMLInputElement>("Bucket（桶名）"), { target: { value: "notes" } });
    fireEvent.change(control<HTMLInputElement>("AccessKey ID"), { target: { value: "ak" } });
    fireEvent.change(control<HTMLInputElement>("Secret Access Key"), { target: { value: "sk" } });
    fireEvent.change(control<HTMLInputElement>("Region"), { target: { value: "cn-hangzhou" } });
    clickApply();
    expect(m.onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/未替换的模板/)).toBeInTheDocument();
    // 测试连接同样被占位符守卫拦下，不触达后端 invoke。
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(screen.getByText(/请先填入真实地址再测试/)).toBeInTheDocument());
    expect(ADAPTER.app.invoke).not.toHaveBeenCalled();
  });

  it("云同步预设语义：region 仅空值预填（R2=auto）、pathStyle 随预设、已填 endpoint 不覆盖", () => {
    renderModal();
    gotoSection("云同步");
    fireEvent.change(control<HTMLInputElement>("Region"), { target: { value: "" } });
    fireEvent.change(control<HTMLSelectElement>("服务商"), { target: { value: "cloudflare-r2" } });
    expect(control<HTMLInputElement>("Endpoint").value).toBe(
      "https://{accountId}.r2.cloudflarestorage.com"
    );
    expect(control<HTMLInputElement>("Region").value).toBe("auto");
    fireEvent.click(screen.getByRole("button", { name: /高级选项/ }));
    expect(control<HTMLInputElement>("Path-style 寻址").checked).toBe(true); // R2 默认开
    // 已填 endpoint：切七牛不粗暴覆盖，pathStyle 随预设翻回关。
    fireEvent.change(control<HTMLInputElement>("Endpoint"), {
      target: { value: "https://my.endpoint.com" },
    });
    fireEvent.change(control<HTMLSelectElement>("服务商"), { target: { value: "qiniu" } });
    expect(control<HTMLInputElement>("Endpoint").value).toBe("https://my.endpoint.com");
    expect(control<HTMLInputElement>("Path-style 寻址").checked).toBe(false);
  });

  it("云同步测试连接：成功载荷走真实 syncConfigPayload（trim + region 兜底），失败映射真实 hint", async () => {
    renderModal();
    gotoSection("云同步");
    // 带空白的凭证 + 空 region：payload 应 trim 且 region 兜底 us-east-1。
    fireEvent.change(control<HTMLInputElement>("Endpoint"), {
      target: { value: "  https://s3.example.com  " },
    });
    fireEvent.change(control<HTMLInputElement>("Bucket（桶名）"), { target: { value: "my-notes" } });
    fireEvent.change(control<HTMLInputElement>("AccessKey ID"), { target: { value: " ak " } });
    fireEvent.change(control<HTMLInputElement>("Secret Access Key"), { target: { value: " sk " } });
    fireEvent.change(control<HTMLInputElement>("Region"), { target: { value: "" } });
    ADAPTER.app.invoke.mockResolvedValueOnce({ bucket: "my-notes", region: "us-east-1" });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(screen.getByText("连接成功：my-notes（us-east-1）")).toBeInTheDocument()
    );
    expect(ADAPTER.app.invoke).toHaveBeenCalledWith("s3_test_connection", {
      cfg: {
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        bucket: "my-notes",
        accessKeyId: "ak",
        secretAccessKey: "sk",
        sessionToken: undefined,
        pathStyle: false,
      },
    });
    // 失败：Rust「SYNC-XXX: …」串经真实 parseSyncError 归类 → 真实中文 hint。
    ADAPTER.app.invoke.mockRejectedValueOnce(new Error("SYNC-003: connect ECONNREFUSED"));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(screen.getByText(/网络不可达/)).toBeInTheDocument());
    expect(screen.getByText(/connect ECONNREFUSED/)).toBeInTheDocument();
  });

  it("Secret Access Key 显隐切换（password ↔ text）", () => {
    renderModal();
    gotoSection("云同步");
    const sk = control<HTMLInputElement>("Secret Access Key");
    expect(sk.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "显示" }));
    expect(sk.type).toBe("text");
    expect(screen.getByRole("button", { name: "隐藏" })).toBeInTheDocument();
  });

  it("关于分区显示 fetchAppVersion 拉取的版本号", async () => {
    renderModal();
    gotoSection("关于");
    await waitFor(() => expect(screen.getByText("9.9.9-test")).toBeInTheDocument());
    expect(fetchAppVersion).toHaveBeenCalled();
  });

  it("关闭语义：取消/X/背景点击关闭且不落盘，卡片内点击不关，Esc 未接线", () => {
    const m = renderModal();
    fireEvent.change(control("主题"), { target: { value: "dark" } }); // 未应用的草稿改动
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(m.onClose).toHaveBeenCalledTimes(1);
    expect(m.onChange).not.toHaveBeenCalled(); // 取消 = 丢弃草稿，不保存
    fireEvent.click(document.querySelector<HTMLElement>(".modal-x")!);
    expect(m.onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("dialog")); // 卡片内点击（stopPropagation）
    expect(m.onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector<HTMLElement>(".modal-backdrop")!);
    expect(m.onClose).toHaveBeenCalledTimes(3);
    // 实际行为：组件未监听 Esc（与 QuickSwitcher/FlashcardModal 不同），记录之。
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(m.onClose).toHaveBeenCalledTimes(3);
  });

  it("取消丢弃草稿：退场动画播完卸载，重开取最新 settings 重建 draft", async () => {
    const settings = baseSettings();
    const m = renderModal(settings);
    fireEvent.change(control("主题"), { target: { value: "sepia" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const backdrop = document.querySelector<HTMLElement>(".modal-backdrop")!;
    m.view.rerender(
      <SettingsModal open={false} settings={settings} onClose={m.onClose} onChange={m.onChange} />
    );
    expect(backdrop.className).toContain("closing"); // 240ms 退场动画窗口
    await new Promise((r) => setTimeout(r, 260));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 重开：draft 从（可能已被外部更新的）settings 重新同步，sepia 被丢弃。
    const updated = baseSettings({ theme: "claude" });
    m.view.rerender(
      <SettingsModal open settings={updated} onClose={m.onClose} onChange={m.onChange} />
    );
    expect(control<HTMLSelectElement>("主题").value).toBe("claude");
  });
});
