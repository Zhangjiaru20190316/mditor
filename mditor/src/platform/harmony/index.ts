// 鸿蒙平台适配器（鸿蒙迁移 v4.11）——全部能力经 bridge-client 走 ArkTS 桥。
//
// 路径语义：业务代码看到的仍是「绝对路径」字符串，但实为 UriMapper 虚拟
// 路径（/Docs/<token>/<相对路径>、/AppData/…）；token ↔ 安全授权 URI 的
// 映射与持久化全部在 ArkTS 侧（harmony/entry/src/main/ets/io/UriMapper.ets）。
// 二进制（readFile/writeFile/fetchImage）经桥以 base64 传输。
//
// 能力矩阵（v4.13 起）：富导出（PNG/DOCX/LaTeX）可用——exporter.ts 全纯
// 前端（dialog.pickSaveFile + fs.writeFile/readFile 桥均已具备）；PDF 走
// iframe print 通道，待真机 spike 确认 ArkWeb 支持系统打印后翻转。
// 其余（AI / 多窗口 / watch / 回收站 / 图片代理 / 自绘窗口控制）见各
// 阶段翻转记录——UI 据能力隐藏入口、降级文案。

import type {
  ConfirmDialogOptions,
  FileFilter,
  MessageDialogOptions,
  PlatformAdapter,
  PlatformApp,
  PlatformCapabilities,
  PlatformDialog,
  PlatformFs,
  PlatformStore,
  PlatformWindow,
  Unlisten,
} from "../types";
import { UnsupportedError } from "../errors";
import { bridge } from "./bridge-client";

// ---- base64 编解码（桥的二进制通道） ----------------------------------------

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // fromCharCode 参数长度上限，分块防栈溢出
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- fs 域 ------------------------------------------------------------------

const harmonyFs: PlatformFs = {
  readTextFile: (path) => bridge.request<string>("fs.readTextFile", { path }),
  readFile: async (path) =>
    fromBase64(
      await bridge.request<{ base64: string }>("fs.readFile", { path }).then((r) => r.base64)
    ),
  writeTextFile: (path, contents) =>
    bridge.request("fs.writeTextFile", { path, content: contents }),
  writeFile: (path, data) =>
    bridge.request("fs.writeFile", { path, base64: toBase64(data) }),
  readDir: (path) =>
    bridge.request("fs.readDir", { path }) as Promise<
      Array<{ name: string; isDirectory: boolean }>
    >,
  mkdir: (path, options) =>
    bridge.request("fs.mkdir", { path, recursive: options?.recursive ?? true }),
  exists: (path) => bridge.request<boolean>("fs.exists", { path }),
  // 桥侧返回 epoch 毫秒（mtimeMs），这里组装成与 plugin-fs 一致的 Date 形态。
  stat: async (path) => {
    const r = await bridge.request<{
      isFile: boolean;
      isDirectory: boolean;
      size: number;
      mtimeMs: number | null;
    }>("fs.stat", { path });
    return {
      isFile: r.isFile,
      isDirectory: r.isDirectory,
      size: r.size,
      mtime: r.mtimeMs != null ? new Date(r.mtimeMs) : null,
    };
  },
  rename: (oldPath, newPath) => bridge.request("fs.rename", { oldPath, newPath }),
  remove: (path, options) =>
    bridge.request("fs.remove", { path, recursive: options?.recursive ?? false }),
  // watch 无实现：capabilities.watch = false，useFileWatcher / vaultIndex 软降级。
};

// ---- 弹窗域 -----------------------------------------------------------------

function filtersToParam(filters?: FileFilter[]) {
  return filters ? { filters } : {};
}

const harmonyDialog: PlatformDialog = {
  pickOpenFile: (filters) =>
    bridge.request<string | null>("dialog.pickOpenFile", filtersToParam(filters)),
  pickSaveFile: (defaultName, filters) =>
    bridge.request<string | null>("dialog.pickSaveFile", {
      defaultName: defaultName ?? "",
      ...filtersToParam(filters),
    }),
  pickDirectory: () => bridge.request<string | null>("dialog.pickDirectory", {}),
  message: (content, options?: MessageDialogOptions) =>
    bridge.request("dialog.message", { content, options: options ?? {} }),
  confirm: (content, options?: ConfirmDialogOptions) =>
    bridge.request<boolean>("dialog.confirm", { content, options: options ?? {} }),
};

// ---- KV 域 ------------------------------------------------------------------

// 桥侧 JSON 无法表达 undefined：缺失键统一返回 null，这里还原为 undefined。
const harmonyStore: PlatformStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const v = await bridge.request<T | null>("store.get", { key });
    return v === null ? undefined : v;
  },
  set: (key, value) => bridge.request("store.set", { key, value }),
  delete: (key) => bridge.request("store.delete", { key }),
  save: () => bridge.request("store.save", {}),
};

// ---- 窗口域 -----------------------------------------------------------------

// 鸿蒙 PC 形态由系统窗口管理接管：控制按钮隐藏，仅保留 close（走桥，
// ArkTS 先广播 window-close-requested 给页面留出收尾窗口再终止）。
const harmonyWindow: PlatformWindow = {
  label: "main",
  minimize: () => bridge.request("app.windowMinimize", {}),
  toggleMaximize: () => bridge.request("app.windowToggleMaximize", {}),
  close: () => bridge.request("app.closeWindow", {}),
  destroy: () => bridge.request("app.closeWindow", {}),
  setTitle: () => Promise.resolve(), // 系统标题栏 MVP 不接管，标题同步跳过
  isMaximized: () => Promise.resolve(false),
  onResized: () => Promise.resolve(() => undefined), // 系统窗口管理接管，无需跟踪
  isFullscreen: () => Promise.resolve(false),
  setFullscreen: () => Promise.resolve(),
  onDragDropEvent: () => Promise.resolve(() => undefined), // ArkWeb 内部拖拽走 DOM 事件
  onCloseRequested: (handler) => {
    const un = bridge.subscribe("window-close-requested", () => {
      void handler({ preventDefault: () => undefined });
    });
    return Promise.resolve(un);
  },
  onFocusChanged: (handler) => {
    const un = bridge.subscribe("window-focus-changed", (payload) => {
      handler({ payload: payload === true });
    });
    return Promise.resolve(un);
  },
};

// ---- 应用域 -----------------------------------------------------------------

const harmonyApp: PlatformApp = {
  // 未注册命令（ai_chat 等四命令）由桥返回 UNSUPPORTED → UnsupportedError。
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    bridge.request<T>(command, args ?? {}),
  appDataDir: () => bridge.request<string>("app.appDataDir", {}),
  appendLog: (path, line, maxBytes) =>
    bridge.request("app.appendLog", { path, line, maxBytes }),
  version: () => bridge.request<string>("app.version", {}),
  getPendingFile: () => Promise.resolve(null),
  // 鸿蒙无公共回收站 API：MVP 语义 = 确认弹窗后永久删除（fileOps 审计层
  // 照走，capabilities.trash = false 驱动文案注明）。
  trashFile: (path) => bridge.request("app.trashFile", { path }),
  // ArkWeb 无 Tauri 式 CSP 锁死：webview 直接 fetch 远程图片字节。
  fetchImage: async (url) =>
    new Uint8Array(await (await fetch(url)).arrayBuffer()),
  // 虚拟路径 → mditor-asset:// URL，由 Index.ets 的 onInterceptRequest 供源。
  convertFileSrc: (path) => `mditor-asset://${encodeURIComponent(path)}`,
  openExternal: (target) => bridge.request("app.openExternal", { target }),
  exitApp: () => bridge.request("app.exitApp", {}),
  webviewWindowCount: () => Promise.resolve(1),
  createDocWindow: () =>
    Promise.reject(new UnsupportedError("鸿蒙版暂不支持多窗口")),
  stashTabPayload: () =>
    Promise.reject(new UnsupportedError("鸿蒙版暂不支持多窗口")),
  takeTabPayload: () => Promise.resolve(null),
  listen: <T>(event: string, handler: (ev: { payload: T }) => void) => {
    const un: Unlisten = bridge.subscribe(event, (payload) =>
      handler({ payload: payload as T })
    );
    return Promise.resolve(un);
  },
  emit: (event, payload) => bridge.request("app.emit", { event, payload }),
  window: harmonyWindow,
};

// ---- 能力矩阵与组装 ----------------------------------------------------------

const HARMONY_CAPS: PlatformCapabilities = {
  ai: true, // ArkTS SSE 代理（AiBridge.ets，契约对齐 ai.rs）
  multiWindow: false,
  watch: false,
  trash: false,
  pdfExport: false, // 待真机 spike：iframe contentWindow.print() 能否唤起系统打印
  richExport: true, // exporter.ts 纯前端（LaTeX/DOCX/PNG 桥依赖已具备）
  remoteImageProxy: false,
  windowControls: false,
};

export const harmonyAdapter: PlatformAdapter = {
  runtime: "harmony",
  fs: harmonyFs,
  dialog: harmonyDialog,
  store: harmonyStore,
  app: harmonyApp,
  capabilities: HARMONY_CAPS,
};
