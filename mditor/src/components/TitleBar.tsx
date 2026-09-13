// 自绘无边框标题栏（decorations:false）：logo + 应用名 + 前端菜单栏 +
// 居中文档名（未保存圆点）+ Windows 惯例三键（最小化/最大化-还原/关闭）。
//
// 整条 header 标注 data-tauri-drag-region 可拖拽移动窗口；Tauri v2 的拖拽
// 脚本只认 mousedown 目标自身带该属性，按钮（菜单/窗口键）天然跳过拖拽，
// 双击空白处原生触发 internal_toggle_maximize（最大化/还原）。
//
// 鸿蒙迁移 v4.11：窗口操作经平台适配层；capabilities.windowControls=false
// 的平台（鸿蒙 PC，系统窗口管理接管）隐藏三键与拖拽区，保留菜单与标题。
//
// React.memo：App 每次按键都重渲染，但本组件 props（name/dirty/focusMode/
// theme/onDispatch）只在文档切换、保存态或模式变化时才变。

import { memo, useEffect, useState } from "react";
import { getAdapter } from "../platform";
import { MenuBar } from "./MenuBar";
import {
  LogoIcon,
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  CloseIcon,
} from "./icons";

interface Props {
  name: string;
  dirty: boolean;
  focusMode: boolean;
  theme: string;
  /** 打字机模式勾选态（透传给菜单栏，V3.6）。 */
  typewriter: boolean;
  onDispatch: (id: string) => void;
}

export const TitleBar = memo(function TitleBar({
  name,
  dirty,
  focusMode,
  theme,
  typewriter,
  onDispatch,
}: Props) {
  // 系统接管窗口控制（鸿蒙 PC）时隐藏三键：能力探测驱动，不改组件结构。
  const showControls = getAdapter().capabilities.windowControls;
  // 最大化状态：onResized 里回查 isMaximized，驱动 □/❐ 图标切换。
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!showControls) return;
    const w = getAdapter().app.window;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void w.isMaximized().then((m) => {
      if (!disposed) setMaximized(m);
    });
    void w
      .onResized(() => {
        void w.isMaximized().then((m) => {
          if (!disposed) setMaximized(m);
        });
      })
      .then((fn) => {
        if (disposed) fn(); // unmount 竞态：立即注销
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // showControls 由运行时决定，进程内不变
  }, [showControls]);

  // 最大化状态同步到 <html class="is-maximized">：v4.2.1 起最大化保留
  // 浮岛圆角，无样式消费该状态，仅作标记供未来窗口级特殊处理使用。
  useEffect(() => {
    document.documentElement.classList.toggle("is-maximized", maximized);
  }, [maximized]);

  return (
    <header
      className="titlebar"
      {...(showControls ? { "data-tauri-drag-region": true } : {})}
    >
      <LogoIcon size={18} className="titlebar-logo" />
      <span className="titlebar-app-name">Mditor</span>
      <MenuBar focusMode={focusMode} theme={theme} typewriter={typewriter} onDispatch={onDispatch} />
      {/* 居中文档名：pointer-events:none 让拖拽穿透到 header 拖拽区 */}
      <div className="titlebar-doc" title={name}>
        {dirty && <span className="titlebar-dot" />}
        <span className="titlebar-doc-name">{name}</span>
      </div>
      {showControls && (
        <div className="titlebar-actions">
          <button
            className="tb-win-btn"
            title="最小化"
            onClick={() => void getAdapter().app.window.minimize()}
          >
            <MinimizeIcon size={14} />
          </button>
          <button
            className="tb-win-btn"
            title={maximized ? "还原" : "最大化"}
            onClick={() => void getAdapter().app.window.toggleMaximize()}
          >
            {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
          </button>
          <button
            className="tb-win-btn close"
            title="关闭"
            onClick={() => void getAdapter().app.window.close()}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}
    </header>
  );
});
