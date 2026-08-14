// Block-level right-click menu for the rich editor surface (wysiwyg/ir only —
// sv keeps the WebView2 native menu).
//
// Structure (built dynamically from the clicked block, see BlockInfo):
//   当前：<块类型>        — gray header
//   转换为：段落 / 标题 1-6 / 引用 / 代码块 / 三种列表 / 分割线（当前类型带 ✓）
//   情境分支：表格 → 插入/删除行列 · 链接 → 打开/复制/编辑/移除 · 图片 → 更换/删除
//   通用：复制块 / 上移 / 下移 / 删除块
//
// All commands act through the Milkdown facade; the caret was already
// normalized onto the clicked block by getBlockInfoAt (right-click alone does
// not move the ProseMirror selection), and the shared ContextMenu shell keeps
// that selection alive via onMouseDown-preventDefault while the user navigates
// the menu. Performance: mounts only while open; entries are memoised.

import { useMemo, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import type { CtxEntry } from "./ContextMenu";
import type { BlockInfo, BlockKind } from "../types";
import type { MilkdownFacade } from "../hooks/useMilkdown";

interface Props {
  /** 打开菜单的屏幕坐标（contextmenu 的 clientX/Y）。 */
  x: number;
  y: number;
  /** 点击处块的快照（facade.getBlockInfoAt 的结果）。 */
  info: BlockInfo;
  facade: MilkdownFacade;
  onClose: () => void;
  /** 用系统浏览器打开链接（Tauri shell open）。 */
  onOpenExternal: (url: string) => void;
  /** 「更换图片」：弹文件选择框 → 持久化 → 写回图片节点。 */
  onReplaceImage: (pos: number) => void;
}

const KIND_LABEL: Record<BlockKind, string> = {
  paragraph: "段落",
  heading: "标题",
  blockquote: "引用",
  code_block: "代码块",
  bullet_list: "无序列表",
  ordered_list: "有序列表",
  task_list: "任务列表",
  hr: "分割线",
  table: "表格",
  image: "图片",
  math_block: "公式块",
  html: "HTML 块",
  other: "块",
};

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板权限失败时退回隐藏 textarea + execCommand。
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
  }
}

export function BlockContextMenu({
  x,
  y,
  info,
  facade,
  onClose,
  onOpenExternal,
  onReplaceImage,
}: Props) {
  // 「编辑链接」把菜单就地切换为一行输入框（回车提交，清空 = 移除链接）。
  const [linkEdit, setLinkEdit] = useState(false);

  const entries = useMemo<CtxEntry[]>(() => {
    const headerLabel =
      info.kind === "heading" && info.headingLevel
        ? `当前：标题 ${info.headingLevel}`
        : `当前：${KIND_LABEL[info.kind]}`;

    const e: CtxEntry[] = [{ kind: "header", key: "hdr", label: headerLabel }];

    // ---- 转换为 …（当前类型带 ✓，标题带 Milkdown 原生快捷键提示）----
    e.push({ kind: "sep", key: "s-conv" });
    e.push({
      kind: "item",
      key: "k-paragraph",
      label: "段落",
      active: info.kind === "paragraph",
      fn: () => facade.setBlockType("paragraph"),
    });
    for (let lv = 1; lv <= 6; lv++) {
      e.push({
        kind: "item",
        key: `k-h${lv}`,
        label: `标题 ${lv}`,
        hint: `Ctrl+Alt+${lv}`,
        active: info.kind === "heading" && info.headingLevel === lv,
        fn: () => facade.setBlockType("heading", lv),
      });
    }
    e.push({
      kind: "item",
      key: "k-quote",
      label: "引用",
      active: info.kind === "blockquote",
      fn: () => facade.setBlockType("blockquote"),
    });
    e.push({
      kind: "item",
      key: "k-code",
      label: "代码块",
      active: info.kind === "code_block",
      fn: () => facade.setBlockType("code_block"),
    });
    e.push({ kind: "sep", key: "s-list" });
    e.push({
      kind: "item",
      key: "k-bullet",
      label: "无序列表",
      active: info.kind === "bullet_list",
      fn: () => facade.setBlockType("bullet_list"),
    });
    e.push({
      kind: "item",
      key: "k-ordered",
      label: "有序列表",
      active: info.kind === "ordered_list",
      fn: () => facade.setBlockType("ordered_list"),
    });
    e.push({
      kind: "item",
      key: "k-task",
      label: "任务列表",
      active: info.kind === "task_list",
      fn: () => facade.setBlockType("task_list"),
    });
    e.push({
      kind: "item",
      key: "k-hr",
      label: "分割线",
      active: info.kind === "hr",
      fn: () => facade.setBlockType("hr"),
    });

    // ---- 情境分支：表格 ----
    if (info.inTable) {
      e.push({ kind: "sep", key: "s-table" });
      e.push({ kind: "item", key: "t-rowb", label: "在上方插入行", fn: () => facade.tableOp("rowBefore") });
      e.push({ kind: "item", key: "t-rowa", label: "在下方插入行", fn: () => facade.tableOp("rowAfter") });
      e.push({ kind: "item", key: "t-colb", label: "在左侧插入列", fn: () => facade.tableOp("colBefore") });
      e.push({ kind: "item", key: "t-cola", label: "在右侧插入列", fn: () => facade.tableOp("colAfter") });
      e.push({ kind: "item", key: "t-rowd", label: "删除此行", fn: () => facade.tableOp("delRow") });
      e.push({ kind: "item", key: "t-cold", label: "删除此列", fn: () => facade.tableOp("delCol") });
    }

    // ---- 情境分支：链接 ----
    if (info.link) {
      const l = info.link;
      e.push({ kind: "sep", key: "s-link" });
      e.push({ kind: "item", key: "l-open", label: "打开链接", fn: () => onOpenExternal(l.href) });
      e.push({ kind: "item", key: "l-copy", label: "复制链接", fn: () => void copyText(l.href) });
      e.push({
        kind: "item",
        key: "l-edit",
        label: "编辑链接…",
        keepOpen: true, // 就地切换为输入行，不关菜单
        fn: () => setLinkEdit(true),
      });
      e.push({
        kind: "item",
        key: "l-remove",
        label: "移除链接",
        fn: () => facade.updateLinkHref(l.from, l.to, ""),
      });
    }

    // ---- 情境分支：图片 ----
    if (info.image) {
      e.push({ kind: "sep", key: "s-img" });
      e.push({ kind: "item", key: "i-replace", label: "更换图片…", fn: () => onReplaceImage(info.image!.pos) });
      e.push({ kind: "item", key: "i-delete", label: "删除图片", danger: true, fn: () => facade.deleteNodeAt(info.image!.pos) });
    }

    // ---- 通用块操作 ----
    e.push({ kind: "sep", key: "s-ops" });
    e.push({ kind: "item", key: "o-dup", label: "复制块", fn: () => facade.duplicateBlock() });
    e.push({
      kind: "item",
      key: "o-up",
      label: "上移",
      hint: "Ctrl+Shift+↑",
      disabled: !info.canMoveUp,
      fn: () => void facade.moveBlock("up"),
    });
    e.push({
      kind: "item",
      key: "o-down",
      label: "下移",
      hint: "Ctrl+Shift+↓",
      disabled: !info.canMoveDown,
      fn: () => void facade.moveBlock("down"),
    });
    e.push({
      kind: "item",
      key: "o-del",
      label: "删除块",
      danger: true,
      fn: () => facade.deleteBlock(),
    });

    return e;
  }, [info, facade, onOpenExternal, onReplaceImage]);

  // 「编辑链接」模式：菜单收缩为一行输入框。
  if (linkEdit && info.link) {
    const l = info.link;
    return (
      <ContextMenu
        x={x}
        y={y}
        onClose={onClose}
        entries={[
          {
            kind: "input",
            key: "link-input",
            initial: l.href,
            placeholder: "链接地址（清空并确定 = 移除链接）",
            onCommit: (v) => {
              facade.updateLinkHref(l.from, l.to, v);
              onClose();
            },
          },
        ]}
      />
    );
  }

  return <ContextMenu x={x} y={y} entries={entries} onClose={onClose} />;
}
