// 平台适配层接口定义（鸿蒙迁移 v4.11）。
//
// 全部业务代码只认这里的接口：Tauri 实现搬运现有 Tauri 官方 API 调用
// （platform/tauri/），鸿蒙实现走 ArkWeb 桥（platform/harmony/）。
// 业务代码禁止直接 import Tauri 官方 API 包（收敛到 platform/tauri/）。
//
// 接口裁剪原则：只定义现有调用点实际用到的方法，不预留用不到的抽象。
// 路径语义按平台而定：Tauri = 真实绝对路径；鸿蒙 = UriMapper 虚拟路径
// （/Docs/<token>/<相对路径>），映射细节全部收在 ArkTS 侧。

/** 运行时名：Tauri 桌面 / 鸿蒙 ArkWeb / 纯浏览器（vite dev 预览）。 */
export type RuntimeName = "tauri" | "harmony" | "browser";

/** 目录项（readDir 返回的条目）。 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

/** 文件元信息（stat 返回；与 plugin-fs FileInfo 的能力子集对齐）。
 *  最后修改时间为 Date 形态（缓存指纹调用点用 .getTime()）。 */
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date | null;
}

/** 文件选择器过滤组（扩展名不带点）。 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/** 事件/监听取消订阅函数。 */
export type Unlisten = () => void;

/** 目录监听事件（plugin-fs WatchEvent 的能力子集）。 */
export interface FsWatchEvent {
  type: { kind?: string };
  paths: string[];
}

// ---- 弹窗域 ----------------------------------------------------------------

export interface MessageDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
}

export interface ConfirmDialogOptions extends MessageDialogOptions {
  okLabel?: string;
  cancelLabel?: string;
}

// ---- 文件域 ----------------------------------------------------------------

/** 文件读写域。MVP 全部业务（文档/工作区/图片/导出）走这 11 个方法。 */
export interface PlatformFs {
  readTextFile(path: string): Promise<string>;
  /** 二进制读（图片读取/导出源文件）。ArrayBuffer 背书以便直接进
   *  Blob/File（与 plugin-fs 的返回类型一致）。 */
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  writeTextFile(path: string, contents: string): Promise<void>;
  /** 二进制写（图片落盘/PNG、docx 导出）。 */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 永久删除（文件或目录，不可恢复）。回收站语义走 app.trashFile。 */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** 目录监听。可选能力——capabilities.watch 为 false 的平台没有此方法，
   *  调用方需先探测（useFileWatcher / vaultIndex 都已按软失败降级）。 */
  watch?(
    path: string,
    handler: (event: FsWatchEvent) => void,
    options?: { recursive?: boolean }
  ): Promise<Unlisten>;
}

/** 弹窗域。open/save 拆成三个语义化方法：鸿蒙侧一一对应 DocumentViewPicker。 */
export interface PlatformDialog {
  /** 选一个已有文件。取消返回 null。 */
  pickOpenFile(filters?: FileFilter[]): Promise<string | null>;
  /** 选保存目标（可带建议文件名）。取消返回 null。 */
  pickSaveFile(defaultName?: string, filters?: FileFilter[]): Promise<string | null>;
  /** 选一个目录（工作区根）。取消返回 null。 */
  pickDirectory(): Promise<string | null>;
  /** 提示框（替代 window.alert）。 */
  message(content: string, options?: MessageDialogOptions): Promise<void>;
  /** 确认框（替代 window.confirm）。 */
  confirm(content: string, options?: ConfirmDialogOptions): Promise<boolean>;
}

/** 持久 KV 域。桌面 = appDataDir/mditor.json（plugin-store）；鸿蒙 = 沙箱
 *  filesDir/mditor.json，键与格式完全一致（settings/recent/workspaces…）。 */
export interface PlatformStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  save(): Promise<void>;
}

// ---- 应用域 ----------------------------------------------------------------

/** 窗口关闭请求事件：preventDefault 阻止默认关闭（自管收尾）。 */
export interface WindowCloseRequestedEvent {
  preventDefault(): void;
}

/** 拖拽事件载荷（Tauri DragDropEvent 的能力子集）。 */
export interface DragDropPayload {
  type: "enter" | "over" | "leave" | "drop";
  paths?: string[];
}

/** 当前窗口操作域（Tauri getCurrentWindow 的能力子集；鸿蒙为系统接管，
 *  自绘控制按钮按 capabilities.windowControls 隐藏）。 */
export interface PlatformWindow {
  /** 窗口标签（Tauri：main / doc-{n}；鸿蒙恒为 "main"）。 */
  readonly label: string;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  destroy(): Promise<void>;
  setTitle(title: string): Promise<void>;
  /** 当前是否最大化（TitleBar 的 □/❐ 图标切换）。 */
  isMaximized(): Promise<boolean>;
  /** 窗口尺寸变化通知（含最大化/还原）。 */
  onResized(handler: () => void): Promise<Unlisten>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(flag: boolean): Promise<void>;
  /** 系统级文件拖入事件（拖 .md 到窗口打开）。不支持的平台不触发。 */
  onDragDropEvent(
    handler: (event: { payload: DragDropPayload }) => void
  ): Promise<Unlisten>;
  onCloseRequested(
    handler: (ev: WindowCloseRequestedEvent) => void | Promise<void>
  ): Promise<Unlisten>;
  onFocusChanged(handler: (ev: { payload: boolean }) => void): Promise<Unlisten>;
}

/** 应用域：命令 / 事件 / 窗口 / 版本等杂项的收口。 */
export interface PlatformApp {
  /** 命令式调用（Tauri invoke 直通；鸿蒙桥只分发已注册方法，未注册命令
   *  返回 UNSUPPORTED——AI 四命令由此自然报不支持）。仅供 Tauri 独有命令
   *  使用；通用能力务必走上面的具名方法，不要新增 invoke 调用点。 */
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** 应用数据目录（Tauri appDataDir / 鸿蒙沙箱 filesDir 的虚拟路径）。 */
  appDataDir(): Promise<string>;
  /** 追加一行日志文件，超出 maxBytes 滚动（Tauri append_log）。 */
  appendLog(path: string, line: string, maxBytes: number): Promise<void>;
  /** 应用版本号。 */
  version(): Promise<string>;
  /** 冷启动暂存文件（命令行带 .md 启动）；无此语义的平台返回 null。 */
  getPendingFile(): Promise<string | null>;
  /** 删除到回收站（可恢复）。无回收站的平台 = 永久删除（capabilities.trash
   *  为 false，UI 需在确认文案注明）。破坏性操作必须经 lib/fileOps 审计层。 */
  trashFile(path: string): Promise<void>;
  /** 下载远程图片字节（Tauri 绕 CSP 的 Rust 代理；无代理的平台直连）。 */
  fetchImage(url: string): Promise<Uint8Array<ArrayBuffer>>;
  /** 本地文件路径 → webview 可渲染的 URL（Tauri asset://；鸿蒙自定义scheme）。 */
  convertFileSrc(path: string): string;
  /** 用系统浏览器打开 URL / 路径。 */
  openExternal(target: string): Promise<void>;
  /** 进程退出。 */
  exitApp(code?: number): Promise<void>;
  /** 全 app webview 窗口数（多窗口收尾判定用）。 */
  webviewWindowCount(): Promise<number>;
  /** 在新窗口打开文档（capabilities.multiWindow 为 false 时不可用）。 */
  createDocWindow(path: string | null, handoff: string | null): Promise<string>;
  /** 标签迁移载荷暂存（多窗口）。 */
  stashTabPayload(payloadJson: string): Promise<string>;
  takeTabPayload(id: string): Promise<string | null>;
  /** 事件总线（menu / open-file / settings-changed / ai_stream_* 等）。 */
  listen<T = unknown>(
    event: string,
    handler: (ev: { payload: T }) => void
  ): Promise<Unlisten>;
  emit(event: string, payload?: unknown): Promise<void>;
  /** 当前窗口。 */
  window: PlatformWindow;
}

// ---- 能力探测 --------------------------------------------------------------

/** 平台能力矩阵 —— UI 据此隐藏/降级不支持的功能（MVP 不做清单的驱动源）。 */
export interface PlatformCapabilities {
  /** AI 代理（Rust SSE 四命令：ai_chat/stream/cancel/embed）。 */
  ai: boolean;
  /** 多窗口多开。 */
  multiWindow: boolean;
  /** 文件/目录监听（外部修改同步）。 */
  watch: boolean;
  /** 删除进系统回收站（可恢复）。false = 永久删除，确认文案需注明。 */
  trash: boolean;
  /** PDF 导出（webview print）。 */
  pdfExport: boolean;
  /** PNG / Word / LaTeX 富导出（MVP 仅保留 HTML）。 */
  richExport: boolean;
  /** 远程图片本地化代理。 */
  remoteImageProxy: boolean;
  /** 自绘窗口控制按钮（最小化/最大化/关闭）。false = 系统窗口管理接管。 */
  windowControls: boolean;
}

/** 平台适配器：业务代码唯一入口（经 platform/index.getAdapter()）。 */
export interface PlatformAdapter {
  readonly runtime: RuntimeName;
  readonly fs: PlatformFs;
  readonly dialog: PlatformDialog;
  readonly store: PlatformStore;
  readonly app: PlatformApp;
  readonly capabilities: PlatformCapabilities;
}
