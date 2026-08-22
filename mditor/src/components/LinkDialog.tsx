// 「插入链接」迷你弹窗（V3.6）：显示文字 + 地址两栏，回车提交。文字默认
// 填入当前选区（由调用方传入）。风格复用 modal-backdrop / modal-card。
// v4.1：useDelayedUnmount 保持挂载约 240ms 播退场动画（.closing）再卸载。

import { useEffect, useRef, useState } from "react";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";

interface Props {
  open: boolean;
  /** 预填的链接文字（通常是当前选区）。 */
  initialText: string;
  onConfirm: (href: string, text: string) => void;
  onClose: () => void;
}

const EXIT_MS = 240;

export function LinkDialog({ open, initialText, onConfirm, onClose }: Props) {
  const [text, setText] = useState("");
  const [href, setHref] = useState("");
  const hrefRef = useRef<HTMLInputElement | null>(null);
  const mounted = useDelayedUnmount(open, EXIT_MS);

  useEffect(() => {
    if (open) {
      setText(initialText);
      setHref("");
      // 等挂载后聚焦地址栏（文字通常已预填）。
      window.setTimeout(() => hrefRef.current?.focus(), 30);
    }
  }, [open, initialText]);

  if (!mounted) return null;

  const submit = () => {
    const url = href.trim();
    if (!url) return;
    onConfirm(url, text.trim());
    onClose();
  };

  return (
    <div className={`modal-backdrop${open ? "" : " closing"}`} onClick={onClose}>
      <div
        className="modal-card link-card"
        role="dialog"
        aria-label="插入链接"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>插入链接</h2>
        </header>
        <div className="link-form">
          <label className="link-row">
            <span className="link-label">显示文字</span>
            <input
              className="link-input"
              value={text}
              placeholder="链接文字（留空使用地址）"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
          <label className="link-row">
            <span className="link-label">链接地址</span>
            <input
              ref={hrefRef}
              className="link-input"
              value={href}
              placeholder="https://…"
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={!href.trim()}>
            插入
          </button>
        </footer>
      </div>
    </div>
  );
}
