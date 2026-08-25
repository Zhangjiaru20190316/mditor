// 开发者模式上下文（v4.3）——「异常发生时，用户在什么环境、刚做了什么、
// 文档有多大」三件事的可复用快照。任何一条异常记录拿到手，不看代码也能
// 大致定位链路与场景，验收口径由本模块承载：
//   * 环境快照 devEnvSnapshot()——应用版本 / 平台 / 窗口尺寸 / DPI / 主题 /
//     编辑模式 / data-big / 最大化 / 侧栏，全部只读 DOM 属性，调用时才采
//     （异常与心跳是低频事件，不值得常驻监听）；
//   * 最近操作环 noteUserAction / recentUserActions——最近 16 次点击/
//     快捷键/语义动作（模式切换、打开文件……），由 devMode 的 window 级
//     捕获监听与 App 的语义埋点写入；
//   * 文档概况 setDevDocInfoProvider / devDocInfo——App 注册的惰性 provider
//     （标签数/活动标签/字符数/行数/图片数），只在快照时调用一次。
//
// node 环境无 DOM：全部降级为 null/省略，接口永不抛错。纯数据模块，
// 不 import 任何会触发副作用的依赖。

import pkg from "../../package.json";

export type DevActionKind = "click" | "key" | "ui";

export interface DevAction {
  ts: number;
  kind: DevActionKind;
  label: string;
}

const ACTION_RING = 16;
const actions: DevAction[] = [];

/** 记一次用户动作（点击/快捷键由捕获监听自动记；语义动作为 ui）。 */
export function noteUserAction(kind: DevActionKind, label: string): void {
  try {
    actions.push({ ts: Date.now(), kind, label: label.slice(0, 80) });
    if (actions.length > ACTION_RING) actions.shift();
  } catch {
    /* never throw */
  }
}

/** 最近动作（旧→新）。 */
export function recentUserActions(): readonly DevAction[] {
  try {
    return actions.slice();
  } catch {
    return [];
  }
}

export function clearDevActions(): void {
  actions.length = 0;
}

/* -------------------------------------------------------------------------- */
/* 环境快照（全部惰性只读，node 降级）                                        */
/* -------------------------------------------------------------------------- */

export interface DevEnvSnapshot {
  /** 应用版本（package.json，与关于弹窗同源打包）。 */
  ver: string;
  platform: string;
  dpr: number | null;
  win: { w: number; h: number } | null;
  theme: string | null;
  mode: string | null;
  big: boolean;
  maximized: boolean;
  focusMode: boolean;
  sidebarClosed: boolean | null;
}

export function devEnvSnapshot(): DevEnvSnapshot {
  const base: DevEnvSnapshot = {
    ver: pkg.version,
    platform:
      typeof navigator !== "undefined" ? navigator.platform : "unknown",
    dpr: null,
    win: null,
    theme: null,
    mode: null,
    big: false,
    maximized: false,
    focusMode: false,
    sidebarClosed: null,
  };
  try {
    if (typeof window !== "undefined") {
      base.dpr = Number(window.devicePixelRatio.toFixed(2)) || null;
      base.win = { w: window.innerWidth, h: window.innerHeight };
    }
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      base.theme = root.getAttribute("data-theme");
      base.maximized = root.classList.contains("is-maximized");
      base.focusMode = root.classList.contains("is-focus");
      const host = document.querySelector<HTMLElement>(".mditor-editor-host");
      base.mode = host?.dataset.mode ?? null;
      base.big = host?.dataset.big !== undefined;
      const sidebar = document.querySelector(".sidebar");
      base.sidebarClosed = sidebar ? sidebar.classList.contains("closed") : null;
    }
  } catch {
    /* never throw */
  }
  return base;
}

/* -------------------------------------------------------------------------- */
/* 文档概况（App 注册的惰性 provider）                                        */
/* -------------------------------------------------------------------------- */

export interface DevDocInfo {
  tabs: number;
  activeTab: string;
  path: string | null;
  chars: number;
  lines: number;
  images: number;
}

type DocInfoProvider = () => DevDocInfo | null;

let docInfoProvider: DocInfoProvider | null = null;

/** App 注册文档概况 provider（每次快照至多调用一次，内容按需现算）。 */
export function setDevDocInfoProvider(fn: DocInfoProvider | null): void {
  docInfoProvider = fn;
}

export function devDocInfo(): DevDocInfo | null {
  try {
    return docInfoProvider ? docInfoProvider() : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 组合快照（异常富集 / 心跳用）                                              */
/* -------------------------------------------------------------------------- */

export interface DevContextSnapshot {
  env: DevEnvSnapshot;
  actions: readonly DevAction[];
  doc: DevDocInfo | null;
}

/** 环境 + 最近操作 + 文档概况的一次性组合（noteAnomaly / 心跳调用）。 */
export function buildDevContext(): DevContextSnapshot {
  return {
    env: devEnvSnapshot(),
    actions: recentUserActions(),
    doc: devDocInfo(),
  };
}
