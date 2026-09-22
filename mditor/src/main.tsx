import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { dismissSplash } from "./lib/splash";
import { attachActivityTracking } from "./lib/activity";
import { attachAnnoDebugGlobal } from "./lib/annoDebug";
import { attachScrollDebugGlobal } from "./lib/scrollDebug";
import { attachOpDebugGlobal } from "./lib/opDebug";
import { attachSysDebugGlobal } from "./lib/sysDebug";
import { attachDevModeGlobal } from "./lib/devMode";
import { detectRuntime } from "./platform";
// KaTeX + highlight.js styles power the static Markdown renderer (AI messages,
// annotation previews, source-mode export) — rehype-katex / rehype-highlight
// emit katex/hljs markup that needs these stylesheets to look right. (The
// editor's own CodeMirror code blocks and Crepe KaTeX are themed by Crepe.)
// 注意：highlight.js 的 github.css 必须在 global.css 之前导入——global.css 末尾
// 用 VSCode 风格配色覆盖了 github.css 的浅色 .hljs-* 规则，相同特异性下后导入
// 的样式才能生效。
import "katex/dist/katex.min.css";
// mhchem 扩展（v4.6）：side-effect import，在全局共享的 KaTeX 实例上注册
// \ce{} 化学式与 \pu 物理单位宏——编辑器（Crepe）、静态管线（rehype-katex）
// 与导出再渲染三条路径用的是同一个 katex 模块实例，这里注册一次全部生效。
// （单实例由 package.json overrides katex=0.18.4 保证——v4.17.1 前静态管线
// 曾解析到嵌套 katex@0.16.47，DOM 类名与应用所载 0.18.4 CSS 镜像失配；归一
// 回归守卫见 src/lib/mathKatexDedupe.test.ts。）
import "katex/contrib/mhchem";
import "highlight.js/styles/github.css";
import "./styles/global.css";
import "./styles/annotation.css";
// 材质基建层（v5）：圆角/玻璃/纵深 token 扩展 + 组件挂材质。必须在
// themes/light.css 之前导入——material.css 的 :root 玻璃/阴影默认值与主题
// 文件的 [data-theme] 调参同特异性，靠「主题在后」的源顺序保证主题胜出
// （懒加载主题 chunk 运行时追加在所有急载样式之后，天然满足）。
import "./styles/material.css";
// Default theme is loaded eagerly so the very first paint is correct; other
// themes are lazy-loaded on demand from useSettings (keeps the initial CSS
// chunk small without a flash of unstyled content for the common case).
import "./styles/themes/light.css";

// WebView2 只要 contextmenu 事件未被取消就会弹出系统原生菜单。这里在捕获
// 阶段全局兜底 preventDefault（各区域的自定义菜单在冒泡阶段照常打开，
// preventDefault 不影响其它监听器）；input/textarea 豁免，保留原生复制/
// 剪切/粘贴（sv 源码框、Crepe link-tooltip 输入框等）。
window.addEventListener(
  "contextmenu",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea")) return;
    e.preventDefault();
  },
  { capture: true }
);

// 用户活动追踪（v3.9）：内存守护/空闲回收据此避开输入与滚动中的重建。
// 纯时间戳标记的 passive 捕获监听，无可测开销。
attachActivityTracking();

// 批注诊断控制台出口（window.__annoDebug）：事件/计数器/体检，供排查时
// 在 DevTools 里直接调用。常驻、零风险（内部全 try/catch）。
attachAnnoDebugGlobal();

// 滚动诊断控制台出口（window.__scrollDebug）：滚动会话归因（用户/程序
// 写入/ghost）、视口位移哨兵、文档高度突变、长任务——「页面自己动 /
// 滚动卡顿」排查时在 DevTools 里直接调用。
attachScrollDebugGlobal();

// 编辑命令遥测出口（window.__opDebug）：被 facade 吞掉的编辑命令异常
// （v3.9.5 blockCommands 自递归正是这样隐形了数周）——stats/report 直读。
attachOpDebugGlobal();

// 系统链路诊断出口（window.__sysDebug）：文件 IO / IPC / AI / 生命周期 /
// 资源加载的事件与计数器（v4.3），DevTools 直读。
attachSysDebugGlobal();

// 开发者模式出口（window.__devMode）：记录器状态 / 异常累计 / 手动冲刷 /
// report 汇总。记录器本体由 App 的 devMode 设置项驱动启停，这里只挂出口。
attachDevModeGlobal();

// 窗口隐藏时暂停纯装饰性动画（AI 悬浮按钮呼吸光晕）：后台窗口无人观看，
// 常驻动画只会白白消耗绘制。CSS 侧用 .app-idle 暂停（见 global.css）。
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("app-idle", document.hidden);
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// 浏览器预览提示条（鸿蒙迁移 v4.11）：既非 Tauri 也非鸿蒙运行时（纯
// `npm run dev` 浏览器访问）时文件/系统功能不可用——过去是静默失败，现在
// 顶部给一条明确提示。DOM 级注入，不进 React 树（对 App 零干扰）。
if (detectRuntime() === "browser") {
  const banner = document.createElement("div");
  banner.textContent = "浏览器预览模式：文件与系统功能不可用。请使用 npm run tauri dev 或桌面安装版。";
  banner.setAttribute("style", [
    "position:fixed", "top:0", "left:50%", "transform:translateX(-50%)",
    "z-index:2147483647", "padding:6px 16px", "border-radius:0 0 8px 8px",
    "background:#b45309", "color:#fff", "font-size:12px", "font-family:system-ui,sans-serif",
    "pointer-events:none", "box-shadow:0 2px 8px rgba(0,0,0,.25)",
  ].join(";"));
  document.body.appendChild(banner);
}

// NOTE: intentionally NOT wrapped in <React.StrictMode>. StrictMode double-mounts
// components in dev; the editor's create effect would init a Crepe instance, tear
// it down, then re-init on the same host — Milkdown tolerates this far better
// than Vditor did, but we keep the no-StrictMode decision to avoid any double-init
// churn on the single external side-effectful instance here.
//
// Wrapped in <ErrorBoundary> instead: any child throwing during render otherwise
// unmounts the whole tree to a blank window (the "settings opens to white screen"
// symptom). The boundary turns such crashes into a visible error card + reload
// button, and logs the real stack to the console.
createRoot(rootEl).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// 兜底：若 App 渲染抛错（ErrorBoundary 接管、App 的 effect 不执行），
// 开屏也不会永远卡住盖住错误卡片。
window.setTimeout(dismissSplash, 4000);
