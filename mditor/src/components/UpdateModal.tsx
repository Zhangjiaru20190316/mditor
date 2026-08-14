// Update notification modal.
//
// Driven by App.tsx: when an update is available, App opens this modal with the
// `Update` handle. The user can then download+install (with a live progress bar)
// or postpone. On install completion the app relaunches (handled in updater.ts),
// so there is no "done" UI state to render — the window simply exits.

import { useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { downloadAndInstall, type DownloadProgress } from "../lib/updater";
import { CloseIcon } from "./icons";

type Phase = "confirm" | "downloading" | "error";

interface Props {
  open: boolean;
  /** New version string, e.g. "0.2.0". */
  version?: string;
  /** Release notes from the manifest (plain text / markdown-ish). */
  body?: string;
  /** The update handle from check(); required to install. */
  update?: Update;
  onClose: () => void;
}

export function UpdateModal({ open, version, body, update, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0 });
  const [error, setError] = useState("");

  if (!open) return null;

  const formatBytes = (n: number | undefined): string => {
    if (!n) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0;

  const handleInstall = async () => {
    if (!update) {
      setError("更新数据缺失，请稍后重试。");
      setPhase("error");
      return;
    }
    setPhase("downloading");
    setProgress({ downloaded: 0 });
    try {
      // On success this never returns — the app relaunches.
      await downloadAndInstall(update, setProgress);
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  return (
    <div className="modal-backdrop" onClick={phase === "downloading" ? undefined : onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-label="检查更新"
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>发现新版本</h2>
          {phase !== "downloading" && (
            <button className="modal-x" onClick={onClose}><CloseIcon size={14} /></button>
          )}
        </header>

        <section className="modal-body">
          {phase === "confirm" && (
            <>
              <p>
                新版本 <strong>v{version}</strong> 可用，是否立即下载并安装？
              </p>
              {body && (
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    maxHeight: 220,
                    overflow: "auto",
                    background: "var(--bg-elev, #f5f5f5)",
                    padding: "10px 12px",
                    borderRadius: 6,
                    fontSize: 13,
                    margin: "8px 0 0",
                  }}
                >
                  {body}
                </pre>
              )}
            </>
          )}

          {phase === "downloading" && (
            <div style={{ padding: "8px 0" }}>
              <p>正在下载更新…</p>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: "var(--bg-elev, #e5e5e5)",
                  overflow: "hidden",
                  margin: "8px 0",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    background: "var(--accent, #4a90e2)",
                    transition: "width 0.15s ease-out",
                  }}
                />
              </div>
              <p style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
                {formatBytes(progress.downloaded)} / {formatBytes(progress.total)} ({pct}%)
              </p>
            </div>
          )}

          {phase === "error" && (
            <p style={{ color: "var(--danger, #c33)" }}>
              更新失败：{error}
              <br />
              请检查网络后稍后重试，或前往发布页手动下载。
            </p>
          )}
        </section>

        <footer className="modal-foot">
          {phase === "confirm" && (
            <>
              <button onClick={onClose}>稍后</button>
              <button
                className="primary"
                onClick={() => void handleInstall()}
                autoFocus
              >
                立即更新
              </button>
            </>
          )}
          {phase === "downloading" && (
            <p style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
              下载完成后应用将自动重启…
            </p>
          )}
          {phase === "error" && (
            <button onClick={onClose}>关闭</button>
          )}
        </footer>
      </div>
    </div>
  );
}
