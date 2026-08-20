// 前端菜单栏 —— Windows 下替代原生菜单（自绘标题栏内嵌）。
// 结构与 Rust 端原生菜单（lib.rs set_menu）完全一致：文件 / 编辑 / 视图 /
// 格式 / 帮助。自定义项经 `onDispatch(id)` 走 App 的 dispatchMenu（与
// 原生 `menu` 事件同一条路径）；原生预定义项（撤销/剪切/全屏/退出/关于）
// 在前端等价实现，见 dispatchMenu 的对应 case。
//
// 交互：点击展开；Alt 聚焦第一个菜单；左右箭头切换菜单、上下箭头 + Enter
// 选择；Esc / 点击外部关闭；悬浮到已展开菜单的相邻菜单自动切换。下拉层
// position:fixed + 视口钳制（对齐 FileTree 的 ContextMenu 写法）。
//
// 下拉层经 createPortal 挂到 document.body：.titlebar 是 position:relative +
// z-index:85 的层叠上下文，会把内部 z-index:95 的下拉层封顶在 85 —— v3.9.4
// 把 .tabbar/.sb-status 升到 85 后（DOM 顺序靠后，同值后者胜），菜单卡片
// 被标签栏整片盖住。Portal 到 body 后 94/95 直接参与根层叠竞争，稳压
// chrome 层(85)/批注弹层(70)/右键菜单(90-91)，仍低于弹窗(100)。
//
// React.memo：App 每次按键都重渲染，但本组件 props（focusMode/theme/
// onDispatch）只在模式或主题变化时才变 —— 打字期间完全跳过重渲染。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "./icons";

/** 单个菜单条目：自定义项（id 转发 dispatchMenu）或分隔线。 */
type MenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      /** 右侧灰字快捷键提示（由 App 全局 keydown 实现，菜单只展示不拦截）。 */
      hint?: string;
      /** 左侧状态标：check = 专注模式勾选；dot = 当前主题圆点。 */
      mark?: "check" | "dot";
      marked?: boolean;
    }
  | { kind: "sep" };

interface MenuDef {
  label: string;
  entries: MenuEntry[];
}

interface Props {
  focusMode: boolean;
  theme: string;
  /** 打字机模式勾选态（V3.6）。 */
  typewriter: boolean;
  onDispatch: (id: string) => void;
}

/** 快捷键提示只标注真实存在的全局快捷键（App keydown / 编辑器表面处理）。 */
function buildMenus(focusMode: boolean, theme: string, typewriter: boolean): MenuDef[] {
  const item = (
    id: string,
    label: string,
    hint?: string
  ): MenuEntry => ({ kind: "item", id, label, hint });
  const sep = (): MenuEntry => ({ kind: "sep" });

  return [
    {
      label: "文件",
      entries: [
        item("file_new", "新建", "Ctrl+N"),
        item("file_new_template", "从模板新建…"),
        item("file_open", "打开文件…", "Ctrl+O"),
        item("file_open_folder", "打开文件夹…", "Ctrl+Shift+O"),
        sep(),
        item("file_save", "保存", "Ctrl+S"),
        item("file_save_as", "另存为…", "Ctrl+Shift+S"),
        sep(),
        item("file_export_pdf", "导出 PDF"),
        item("file_export_html", "导出 HTML"),
        item("file_export_png", "导出图片 (PNG)"),
        item("file_export_docx", "导出 Word (docx)"),
        sep(),
        item("app_exit", "退出"),
      ],
    },
    {
      label: "编辑",
      entries: [
        item("edit_undo", "撤销", "Ctrl+Z"),
        item("edit_redo", "重做", "Ctrl+Y"),
        sep(),
        item("edit_cut", "剪切", "Ctrl+X"),
        item("edit_copy", "复制", "Ctrl+C"),
        item("edit_paste", "粘贴", "Ctrl+V"),
        item("edit_select_all", "全选", "Ctrl+A"),
        sep(),
        item("edit_copy_rich", "复制为富文本（粘贴到微信/Word 保留格式）"),
      ],
    },
    {
      label: "视图",
      entries: [
        item("view_outline", "切换大纲"),
        item("view_filetree", "切换文件树"),
        item("view_search", "在工作区中搜索", "Ctrl+Shift+F"),
        { kind: "item", id: "view_focus", label: "专注模式", mark: "check", marked: focusMode },
        { kind: "item", id: "view_typewriter", label: "打字机模式", mark: "check", marked: typewriter },
        item("view_ai_assistant", "AI 助手", "Ctrl+I"),
        sep(),
        { kind: "item", id: "theme_light", label: "浅色主题", mark: "dot", marked: theme === "light" },
        { kind: "item", id: "theme_dark", label: "深色主题", mark: "dot", marked: theme === "dark" },
        { kind: "item", id: "theme_sepia", label: "护眼主题", mark: "dot", marked: theme === "sepia" },
        sep(),
        item("view_fullscreen", "全屏", "F11"),
      ],
    },
    {
      label: "格式",
      entries: [
        item("format_bold", "加粗", "Ctrl+B"),
        item("format_italic", "斜体"),
        item("format_strike", "删除线"),
        item("format_code", "行内代码"),
        item("format_highlight", "高光", "Ctrl+Shift+H"),
        sep(),
        item("insert_link", "插入链接…"),
        item("insert_image", "插入图片…"),
        item("insert_footnote", "插入脚注"),
      ],
    },
    {
      label: "帮助",
      entries: [
        item("app_settings", "设置…"),
        sep(),
        item("app_about", "关于 Mditor"),
      ],
    },
  ];
}

export const MenuBar = memo(function MenuBar({ focusMode, theme, typewriter, onDispatch }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  // 下拉层视口坐标（fixed + 钳制），展开 / 切换菜单时按按钮 rect 重算。
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // 全部条目里只有 4 条动态（专注模式勾选 + 3 个主题圆点），其余全静态
  // —— 用 useMemo 把结构稳定下来，仅 focusMode/theme 变化时重建，pos/open 等
  // 无关重渲染不再产生新数组（也避免 keydown 副作用因 menus 引用变化重挂）。
  const menus = useMemo(
    () => buildMenus(focusMode, theme, typewriter),
    [focusMode, theme, typewriter]
  );
  // keydown 副作用实际只用到条目数量（导航循环取模），抽出为原始值依赖。
  const menuCount = menus.length;
  const close = useCallback(() => setOpen(null), []);

  const activate = useCallback(
    (entry: Extract<MenuEntry, { kind: "item" }>) => {
      setOpen(null);
      onDispatch(entry.id);
    },
    [onDispatch]
  );

  // 展开时定位下拉层：锚在按钮下方，按估算尺寸钳制进视口。
  useLayoutEffect(() => {
    if (open === null) return;
    const btn = btnRefs.current[open];
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const estW = 260;
    const estH = menus[open].entries.length * 28 + 12;
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - estW - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - estH - 8)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- menus 只影响高度估算
  }, [open]);

  // 键盘导航：菜单关闭时 Alt 展开第一个；展开时方向键 / Esc / Alt 关闭。
  // 用捕获阶段注册 —— 本组件随状态变化会重挂监听（排到 App 的全局 keydown
  // 之后），捕获恒先于冒泡执行，Esc 的 stopImmediatePropagation 才能保证
  // 「先关菜单、不连带退出焦点模式」。
  // 依赖收敛到实际使用的值：open + menuCount（原始值，只在菜单数量变化时才
  // 改变）；moveFocus 移入 effect 内，不参与依赖 → pos 等无关渲染不再重挂。
  useEffect(() => {
    /** 在当前下拉层的条目间移动 DOM 焦点（Enter 由聚焦的 <button> 原生触发）。 */
    const moveFocus = (dir: 1 | -1) => {
      const items = dropdownRef.current?.querySelectorAll<HTMLButtonElement>(".mb-item");
      if (!items || items.length === 0) return;
      const list = Array.from(items);
      const idx = list.findIndex((b) => b === document.activeElement);
      const next = idx === -1 ? (dir === 1 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
      list[next].focus();
    };

    const onKey = (e: KeyboardEvent) => {
      if (open === null) {
        if (e.key === "Alt" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          e.preventDefault();
          setOpen(0);
        }
        return;
      }
      const count = menuCount;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopImmediatePropagation();
          setOpen(null);
          break;
        case "ArrowLeft":
          e.preventDefault();
          setOpen((open - 1 + count) % count);
          break;
        case "ArrowRight":
          e.preventDefault();
          setOpen((open + 1) % count);
          break;
        case "ArrowDown":
          e.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveFocus(-1);
          break;
        case "Tab":
        case "Alt":
          e.preventDefault();
          setOpen(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, menuCount]);

  return (
    <nav className="mb" aria-label="应用菜单">
      {menus.map((m, i) => (
        <button
          key={m.label}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          className={`mb-btn${open === i ? " open" : ""}`}
          aria-expanded={open === i}
          aria-haspopup="menu"
          onClick={() => setOpen(open === i ? null : i)}
          onMouseEnter={() => {
            if (open !== null && open !== i) setOpen(i);
          }}
        >
          {m.label}
        </button>
      ))}

      {open !== null &&
        createPortal(
          <>
            {/* 点击外部关闭：背板从标题栏下缘开始，标题栏上的菜单按钮保持可点
                （点击相邻菜单 = 直接切换，无需先关再开）。 */}
            <div
              className="mb-backdrop"
              onMouseDown={close}
              onContextMenu={(e) => {
                e.preventDefault();
                close();
              }}
            />
            <div className="mb-dropdown" role="menu" style={pos} ref={dropdownRef}>
              {menus[open].entries.map((entry, j) =>
                entry.kind === "sep" ? (
                  <div key={`sep-${j}`} className="mb-sep" />
                ) : (
                  <button
                    key={entry.id}
                    className="mb-item"
                    role="menuitem"
                    onClick={() => activate(entry)}
                  >
                    <span className="mb-item-mark">
                      {entry.marked && entry.mark === "check" && <CheckIcon size={12} />}
                      {entry.marked && entry.mark === "dot" && <span className="mb-dot" />}
                    </span>
                    <span className="mb-item-label">{entry.label}</span>
                    {entry.hint && <span className="mb-item-hint">{entry.hint}</span>}
                  </button>
                )
              )}
            </div>
          </>,
          document.body
        )}
    </nav>
  );
});
