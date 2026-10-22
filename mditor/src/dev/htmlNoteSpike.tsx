// 阶段 0 Spike 专用验证通道（dev-only，不进主干 UI）。
//
// 用途：在真实 Tauri 窗口里把「官方测试页」以生产预期的 iframe 形态
// （asset 协议 URL + sandbox 无 allow-same-origin）加载出来，实测：
//   ① 内联 <script> 是否执行；
//   ② 相对路径子资源（子目录 / .. 上跳 / 外链 CSS）是否按文档 URL 解析；
//   ③ 隔离三断言（测试页自检面板 + 上报采集器）。
// 实测记录见 docs/html-note-spike-report.md；通道随阶段 0 提交，作为
// 可复现的验证工具长期保留（仅 import.meta.env.DEV 下挂载，产物构建
// 中被静态消除）。
//
// 挂载：App.tsx 尾部 DEV 门控 + lazy。自动弹出：public/ 下存在
// html-note-spike-auto.flag 时（跑批采证用，平时不创建）。

import { useCallback, useEffect, useState } from "react";
import { getAdapter } from "../platform";
import { join } from "../lib/path-shim";
// 阶段 1 起 URL 构造与 sandbox 形态以 lib/htmlNote 为单一来源（spike 通道
// 与生产 HtmlNoteView 共用同一实现，防两处漂移）。
import { assetFrameUrl, HTML_NOTE_SANDBOX as SANDBOX } from "../lib/htmlNote";

const LS_KEY = "mditor.spike.htmlNoteDir";
const DEFAULT_DIR = "C:\\Users\\hh\\Desktop\\Tp\\mditor\\public\\html-note-demo";

export function HtmlNoteSpike() {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [srcKey, setSrcKey] = useState(0);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const saved = window.localStorage.getItem(LS_KEY);
    if (saved) setDir(saved);
    // 跑批采证：public/html-note-spike-auto.flag 存在即自动弹出并加载。
    // 注意 vite 的 SPA fallback 对任意不存在路径都回 200（index.html），
    // 必须校验 content-type 排除 html——否则每次 dev 启动都会误弹。
    fetch("/html-note-spike-auto.flag")
      .then((r) => {
        const ct = r.headers.get("content-type") ?? "";
        if (r.ok && !ct.includes("text/html")) {
          setOpen(true);
          start(saved ?? DEFAULT_DIR);
        }
      })
      .catch(() => undefined);
    // start 身份稳定（空依赖），首帧即可安全引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback((d: string) => {
    setStatus("授权目录…");
    window.localStorage.setItem(LS_KEY, d);
    getAdapter()
      .app.grantFsScope?.([d], true)
      .then(() => {
        setStatus("已授权（fs + asset scope）");
        setSrcKey((k) => k + 1);
      })
      .catch((e) => setStatus(`授权失败：${String(e)}`));
  }, []);

  if (!open) {
    return (
      <button
        style={{
          position: "fixed", right: 12, bottom: 40, zIndex: 9999,
          padding: "6px 10px", fontSize: 12, opacity: 0.75,
        }}
        onClick={() => setOpen(true)}
      >
        🧪 HTML 笔记 Spike
      </button>
    );
  }

  const mainSrc = assetFrameUrl(join(dir, "index.html"));
  const subSrc = assetFrameUrl(join(dir, "sub", "relative.html"));
  const probeSrc = assetFrameUrl(join(dir, "ipc-probe.html"));

  // srcKey=0（尚未授权/加载）时不挂 iframe：授权是异步的，未授权的盲加载
  // 只会得到一帧被 scope 拒绝的空白，污染观察。
  const frame = (key: string, src: string, title: string, style: React.CSSProperties, sandbox?: string) =>
    srcKey > 0 ? (
      <iframe
        key={key}
        src={src}
        {...(sandbox ? { sandbox } : {})}
        title={title}
        style={{ ...style, background: "#fff", border: "1px solid #ccc", borderRadius: 6 }}
      />
    ) : (
      <div style={{ ...style, border: "1px dashed #bbb", borderRadius: 6, color: "#888", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>
        点击「加载」：先授权目录（fs + asset scope）再挂 iframe
      </div>
    );

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 99999, background: "#f4f4f5",
        display: "flex", flexDirection: "column", padding: 8, gap: 6,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <b>HTML 笔记 Spike 通道（dev-only）</b>
        <input
          style={{ flex: 1, font: "12px monospace", padding: "3px 6px" }}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
        <button onClick={() => start(dir)}>加载</button>
        <button onClick={() => setSrcKey((k) => k + 1)}>重载</button>
        <button onClick={() => setOpen(false)}>关闭</button>
        <span style={{ color: "#555" }}>{status}</span>
      </div>
      <div style={{ font: "11px monospace", color: "#666", wordBreak: "break-all" }}>
        main: {mainSrc}
      </div>
      {frame(`main-${srcKey}`, mainSrc, "spike-main", { flex: 1 }, SANDBOX)}
      {frame(`sub-${srcKey}`, subSrc, "spike-sub", { height: 200 }, SANDBOX)}
      {/* 纵深防御探针：无 sandbox 的 asset iframe，invoke 也必须被拒 */}
      {frame(`probe-${srcKey}`, probeSrc, "spike-probe", { height: 120 })}
    </div>
  );
}

