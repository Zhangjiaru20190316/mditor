// FIRST import: this module AUTO-INSTALLS the early timer probe on load (see
// lib/leakCounters), patching globalThis.requestAnimationFrame/setInterval/
// setTimeout before react-dom / @milkdown / any dependency can capture a
// reference. TEMPORARY diagnostic — remove once the idle leak is found.
import "./lib/leakCounters";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
