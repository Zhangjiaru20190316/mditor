// 「关于」迷你弹窗（帮助 → 关于）：logo + 版本 + 简介。
// 风格仿 modal-backdrop / modal-card 体系。

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { LogoIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AboutModal({ open, onClose }: Props) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        if (!cancelled) setVersion("");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card about-card"
        role="dialog"
        aria-label="关于 Mditor"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-body">
          <LogoIcon size={44} className="about-logo" />
          <h2 className="about-name">Mditor</h2>
          <p className="about-version">版本 {version || "—"}</p>
          <p className="about-desc">
            本地优先的 Markdown 编辑器（Tauri 2 + React + Milkdown）。
            无云端、无遥测 —— 文件始终保存在你的电脑上。
          </p>
        </div>
        <footer className="modal-foot">
          <button className="btn-primary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
