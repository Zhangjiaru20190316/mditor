import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { dismissSplash } from "./lib/splash";
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
