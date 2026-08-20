import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { dismissSplash } from "./lib/splash";
import { attachActivityTracking } from "./lib/activity";
import { attachAnnoDebugGlobal } from "./lib/annoDebug";
import { attachScrollDebugGlobal } from "./lib/scrollDebug";
import { attachOpDebugGlobal } from "./lib/opDebug";
// KaTeX + highlight.js styles power the static Markdown renderer (AI messages,
// annotation previews, source-mode export) — rehype-katex / rehype-highlight
// emit katex/hljs markup that needs these stylesheets to look right. (The
// editor's own CodeMirror code blocks and Crepe KaTeX are themed by Crepe.)
// 注意：highlight.js 的 github.css 必须在 global.css 之前导入——global.css 末尾
// 用 VSCode 风格配色覆盖了 github.css 的浅色 .hljs-* 规则，相同特异性下后导入
// 的样式才能生效。
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./styles/global.css";
import "./styles/annotation.css";
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

// 窗口隐藏时暂停纯装饰性动画（AI 悬浮按钮呼吸光晕）：后台窗口无人观看，
// 常驻动画只会白白消耗绘制。CSS 侧用 .app-idle 暂停（见 global.css）。
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("app-idle", document.hidden);
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

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
