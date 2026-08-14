// Top-level error boundary.
//
// React 18 unmounts the WHOLE tree when a child throws during render — which
// shows up as a blank window (the "settings opens to white screen" symptom).
// Wrapping <App/> in this boundary turns such crashes into a visible error card
// with a reload button, and surfaces the real exception in the console instead
// of silently going blank.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional label shown in the error card, e.g. "设置面板". */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Print the real stack so the cause is visible in Tauri's DevTools console.
    console.error("[ErrorBoundary]", this.props.label ?? "render", error, info);
  }

  private handleReload = () => {
    this.setState({ error: null });
    // A hard reload is the most reliable way to recover a wedged webview state.
    if (typeof location !== "undefined") location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const where = this.props.label ? `（${this.props.label}）` : "";
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#f6f6f6",
          color: "#222",
          fontFamily:
            '"Segoe UI", -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif',
          zIndex: 9999,
        }}
      >
        <div
          style={{
            maxWidth: 560,
            background: "#fff",
            border: "1px solid #e5e5e5",
            borderRadius: 10,
            boxShadow: "0 10px 40px rgba(0,0,0,.12)",
            padding: 24,
          }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>
            出错了{where}
          </h2>
          <p style={{ margin: "0 0 12px", color: "#666", fontSize: 14 }}>
            渲染过程中发生了异常。这通常不是你的数据问题。点击下方按钮重载；
            如果反复出现，请把这段错误信息反馈给开发者。
          </p>
          <pre
            style={{
              background: "#1e1e1e",
              color: "#ffb4b4",
              padding: 12,
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
              overflow: "auto",
              maxHeight: 220,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error.name}: {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button
              onClick={this.handleReload}
              style={{
                padding: "8px 16px",
                background: "#3b82f6",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
