// @vitest-environment jsdom
// PrintDialog 组件测试（PI2）。范式沿用 SettingsModal.test.tsx：
//   * 平台层 vi.mock（app.invoke = list_printers 面走 mockADAPTER）；
//   * 重链 mock：lib/printJob 的 buildPrintPdfBytes / runPrintJob /
//     listPrinters、lib/pdfjsLazy 的 loadPdfjs（pdf.js 渲染面不在组件测试
//     范围）；parsePageRange 等纯逻辑走真实实现（importOriginal 展开）；
//   * jsdom 无 IntersectionObserver / ResizeObserver / 2d canvas——全局
//     stub（预览页渲染静默，DOM 结构与交互不受影响）；
//   * RTL v16 无全局 afterEach：显式 cleanup。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrintDialog, type PrintDialogProps } from "./PrintDialog";
import { runPrintJob, listPrinters } from "../lib/printJob";
import type { PrintPrefs } from "../types";

// ---- mock 面 -------------------------------------------------------------------

const { ADAPTER } = vi.hoisted(() => ({
  ADAPTER: {
    app: {
      invoke: vi.fn(),
      appDataDir: vi.fn(async () => "/appdata"),
      listen: vi.fn(async () => () => undefined),
    },
    fs: {
      writeFile: vi.fn(async () => undefined),
      // pdf kind 走真实 readPdfPrintBytes → readDocNoteBytes → fs.readFile。
      readFile: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    },
    dialog: { pickSaveFile: vi.fn(async () => null) },
  },
}));

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri" as const,
  getAdapter: () => ADAPTER,
}));

vi.mock("../lib/pdfjsLazy", () => ({
  loadPdfjs: vi.fn(async () => ({
    getDocument: () => ({
      promise: Promise.resolve(FAKE_DOC),
      destroy: vi.fn(async () => undefined),
    }),
  })),
}));

/** 两页 A4 假文档（getPage 的 view 决定页卡片比例）。 */
const FAKE_DOC = {
  numPages: 2,
  getPage: vi.fn(async () => ({
    view: [0, 0, 595.28, 841.89],
    getViewport: ({ scale }: { scale: number }) => ({
      width: 595.28 * scale,
      height: 841.89 * scale,
    }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
  })),
};

vi.mock("../lib/printJob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/printJob")>();
  return {
    ...actual,
    buildPrintPdfBytes: vi.fn(async () => ({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      missing: [],
      meta: {},
    })),
    runPrintJob: vi.fn(async () => ({ outcome: "done" as const, total: 2 })),
    listPrinters: vi.fn(),
  };
});

// jsdom 全局 stub：预览页/容器宽度观测。
class FakeIO {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}
vi.stubGlobal("IntersectionObserver", FakeIO);
vi.stubGlobal("ResizeObserver", FakeIO);

const PREFS: PrintPrefs = {
  paper: "A4",
  orientation: "portrait",
  marginMm: 15,
  lastPrinter: null,
};

function baseProps(over: Partial<PrintDialogProps> = {}): PrintDialogProps {
  return {
    request: {
      kind: "md",
      stem: "测试笔记",
      path: null,
      mdContextProvider: async () => ({ html: "<p>x</p>", css: "", docPath: null }),
    },
    onClose: vi.fn(),
    prefs: PREFS,
    onPrefsChange: vi.fn(),
    flashStatus: vi.fn(),
    showAlert: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (listPrinters as Mock).mockResolvedValue([
    { name: "Microsoft Print to PDF", isDefault: true },
    { name: "HP LaserJet", isDefault: false },
  ]);
});

afterEach(cleanup);

/** 等待排版完成（phase ready 的标志：页脚「共 N 页」出现）。 */
async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByText("共 2 页")).toBeInTheDocument());
}

describe("PrintDialog（PI2 自研打印对话框）", () => {
  it("md kind：ready 后控件齐全，打印机默认项预选，打印可点", async () => {
    render(<PrintDialog {...baseProps()} />);
    await ready();
    // 打印机下拉：默认项带标记。
    const sel = screen.getByDisplayValue("Microsoft Print to PDF（默认）") as HTMLSelectElement;
    expect(sel).toBeInTheDocument();
    // 设置面控件齐全。
    expect(screen.getByText("份数")).toBeInTheDocument();
    expect(screen.getByText("页面范围")).toBeInTheDocument();
    expect(screen.getByText("纸张")).toBeInTheDocument();
    expect(screen.getByText("方向")).toBeInTheDocument();
    expect(screen.getByText("边距")).toBeInTheDocument();
    expect(screen.getByText("打印质量")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打印" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存 PDF…" })).toBeEnabled();
  });

  it("无打印机：提示降级、打印禁用、保存 PDF 仍可用", async () => {
    (listPrinters as Mock).mockResolvedValue([]);
    render(<PrintDialog {...baseProps()} />);
    await ready();
    expect(screen.getByText(/未检测到打印机/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打印" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存 PDF…" })).toBeEnabled();
  });

  it("自定义页码范围：非法禁用+原因；合法后点打印 → runPrintJob 收到所选页；完成后关闭并回写偏好", async () => {
    const onPrefsChange = vi.fn();
    const onClose = vi.fn();
    render(<PrintDialog {...baseProps({ onPrefsChange, onClose })} />);
    await ready();
    const printBtn = screen.getByRole("button", { name: "打印" });
    fireEvent.click(screen.getByLabelText("自定义"));
    const rangeInput = screen.getByPlaceholderText(/如：1-3, 5/);
    // 非法：格式错。
    fireEvent.change(rangeInput, { target: { value: "abc" } });
    await waitFor(() => expect(screen.getByText(/无法识别的页码/)).toBeInTheDocument());
    expect(printBtn).toBeDisabled();
    // 合法：仅第 2 页。
    fireEvent.change(rangeInput, { target: { value: "2" } });
    await waitFor(() => expect(screen.getByText("已选 1 页")).toBeInTheDocument());
    expect(printBtn).toBeEnabled();
    fireEvent.click(printBtn);
    await waitFor(() => expect(runPrintJob).toHaveBeenCalled());
    const arg = (runPrintJob as Mock).mock.calls[0][0];
    expect(arg.pages).toEqual([2]);
    expect(arg.printer).toBe("Microsoft Print to PDF");
    expect(arg.paper).toBe("A4");
    // 完成（mock outcome=done）→ 关闭 + 偏好回写（含默认打印机名）。
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onPrefsChange).toHaveBeenCalledWith(
      expect.objectContaining({ lastPrinter: "Microsoft Print to PDF" })
    );
  });

  it("pdf kind：纸张/方向/边距禁用（按原文件直打）", async () => {
    const props = baseProps({
      request: {
        kind: "pdf",
        stem: "原文件",
        path: "C:/docs/x.pdf",
        mdContextProvider: null,
      },
    });
    render(<PrintDialog {...props} />);
    await ready();
    const disabled = screen
      .getAllByRole("combobox")
      .filter((el) => (el as HTMLSelectElement).disabled);
    // 纸张 + 方向 + 边距三个 select 禁用（打印机/质量可用）。
    expect(disabled.length).toBe(3);
    expect(screen.getByText(/原文件页面直打/)).toBeInTheDocument();
  });

  it("Esc 关闭（printing 外直接关；flashStatus 成功提示由 onClose 前触发）", async () => {
    const onClose = vi.fn();
    render(<PrintDialog {...baseProps({ onClose })} />);
    await ready();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("runPrintJob 失败：phase 复位 ready（打印可再点）+ showAlert 显式报错", async () => {
    const showAlert = vi.fn();
    (runPrintJob as Mock).mockRejectedValueOnce(new Error("spooler 不可用"));
    render(<PrintDialog {...baseProps({ showAlert })} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "打印" }));
    await waitFor(() =>
      expect(showAlert).toHaveBeenCalledWith(
        expect.stringContaining("spooler 不可用"),
        "打印",
        "error"
      )
    );
    // phase 复位 ready：打印按钮回到可用态（不是卡在 printing）。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "打印" })).toBeEnabled()
    );
  });

  it("打印中点「取消打印」：abort 传给 runPrintJob 的 signal，按已取消收场复位", async () => {
    const flashStatus = vi.fn();
    // 模拟一个「不会自己完成」的作业：只有 signal abort 才收场（对应 GDI
    // 页边界取消语义）。
    (runPrintJob as Mock).mockImplementation(
      (o: { signal: AbortSignal }) =>
        new Promise((res) => {
          if (o.signal.aborted) {
            res({ outcome: "cancelled" as const, total: 0 });
            return;
          }
          o.signal.addEventListener(
            "abort",
            () => res({ outcome: "cancelled" as const, total: 0 }),
            { once: true }
          );
        })
    );
    render(<PrintDialog {...baseProps({ flashStatus })} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "打印" }));
    // printing 态：取消按钮出现（打印按钮让位）。
    const cancelBtn = await waitFor(() =>
      screen.getByRole("button", { name: "取消打印" })
    );
    expect(screen.queryByRole("button", { name: "打印" })).toBeNull();
    fireEvent.click(cancelBtn);
    await waitFor(() =>
      expect(flashStatus).toHaveBeenCalledWith("已取消打印", 5000)
    );
    // 复位 ready：可再次发起打印（非卡死态）。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "打印" })).toBeEnabled()
    );
  });

  it("docx 源准备失败（读盘错误）→ failed 态显式报错（不残留 prepare 转圈）", async () => {
    (ADAPTER.fs.readFile as Mock).mockRejectedValueOnce(new Error("disk I/O error"));
    const props = baseProps({
      request: {
        kind: "docx",
        stem: "坏文件",
        path: "C:/docs/broken.docx",
        mdContextProvider: null,
      },
    });
    render(<PrintDialog {...props} />);
    await waitFor(() =>
      expect(screen.getByText("无法准备打印内容")).toBeInTheDocument()
    );
    expect(screen.getByText(/disk I\/O error/)).toBeInTheDocument();
  });
});
