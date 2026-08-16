// 内联 SVG 图标集 —— 替代全局 emoji 图标的统一视觉体系。
// 全部图标共享 24×24 viewBox、stroke 风格（currentColor / 2px 圆角笔触），
// 尺寸由调用方经 `size` 指定（默认 16），颜色跟随 currentColor（继承 color）。

import type { ReactNode } from "react";

export interface IconProps {
  /** 渲染尺寸（px），默认 16。 */
  size?: number;
  className?: string;
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* ---------------- Mditor 标识 ---------------- */

/** MD 标识：圆角方框 + 「M」字形（与桌面图标同源的 M 比例）。 */
export function LogoIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="3.5" />
      <path d="M7.5 15.5v-6.5l4.5 4 4.5-4v6.5" />
    </Svg>
  );
}

/* ---------------- 窗口控制（Windows 惯例三键） ---------------- */

export function MinimizeIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function MaximizeIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </Svg>
  );
}

/** 还原（最大化态）：前后双框。 */
export function RestoreIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9 5h9a1 1 0 0 1 1 1v9" />
      <rect x="5" y="9" width="10" height="10" rx="1" />
    </Svg>
  );
}

export function CloseIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}

/* ---------------- 侧边栏四个面板 ---------------- */

/** 文件树：根节点 + 引导线 + 两行子项。 */
export function FileTreeIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 6h5" />
      <path d="M8 6v12" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
    </Svg>
  );
}

/** 大纲：带行首圆点的列表线。 */
export function OutlineIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9 6h12" />
      <path d="M9 12h12" />
      <path d="M9 18h12" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </Svg>
  );
}

/** 最近：时钟。 */
export function RecentIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

/** 批注：折角便签。 */
export function AnnotationIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z" />
      <path d="M15 3v4a2 2 0 0 0 2 2h4" />
    </Svg>
  );
}

/* ---------------- 文件树工具栏 / 行内 ---------------- */

/** 新建文件：文档 + 加号（右下角叠加标）。 */
export function NewFileIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </Svg>
  );
}

/** 新建文件夹：文件夹 + 加号。 */
export function NewFolderIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 10.5v5" />
      <path d="M9.5 13h5" />
    </Svg>
  );
}

/** 刷新：环形箭头。 */
export function RefreshIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  );
}

/** 批量选择：对勾方框。 */
export function BatchIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

/** 收起态文件夹。 */
export function FolderIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

/** 展开态文件夹（开盖）。 */
export function FolderOpenIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" />
      <path d="M3 8h17.3a1 1 0 0 1 .97 1.29l-1.83 6.32A2 2 0 0 1 17.55 17H5.6a2 2 0 0 1-1.9-1.42L3 11.5Z" />
    </Svg>
  );
}

/** Markdown 文件：空白文档。 */
export function MarkdownFileIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </Svg>
  );
}

/* ---------------- 面板开关 / AI / 专注 ---------------- */

/** 侧边栏：左分栏面板。 */
export function SidebarIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Svg>
  );
}

/** AI：机器人头。 */
export function AiIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V5" />
      <circle cx="12" cy="3.5" r="1" />
      <path d="M2 13h2" />
      <path d="M20 13h2" />
      <path d="M9 13v2" />
      <path d="M15 13v2" />
    </Svg>
  );
}

/** 专注模式 / 切换工作区（⤢ 四角向外）。 */
export function ExpandIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 9V5a1 1 0 0 1 1-1h4" />
      <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h4" />
      <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    </Svg>
  );
}

/* ---------------- 通用 ---------------- */

/** 右向箭头（树形展开钮 / 折叠区切换）：配 .chevron / .chevron.open 旋转。 */
export function ChevronRightIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="m9 5 7 7-7 7" />
    </Svg>
  );
}

/** 对勾（菜单选中态 / 批量模式）。 */
export function CheckIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="m5 12 5 5 9-9" />
    </Svg>
  );
}

/** 清空对话（垃圾桶）。 */
export function TrashIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Svg>
  );
}

/** 高光（荧光笔）。 */
export function HighlightIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="m9 11-6 6v3h9l3-3" />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </Svg>
  );
}

/** 文字颜色（A 字母 + 彩色下划线）。下划线用渐变以传达"取色"含义。 */
export function TextColorIcon({ size, className }: IconProps) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="tc-underline" x1="3" y1="0" x2="21" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="#e53935" />
          <stop offset="0.33" stopColor="#fdd835" />
          <stop offset="0.66" stopColor="#43a047" />
          <stop offset="1" stopColor="#1e88e5" />
        </linearGradient>
      </defs>
      {/* 「A」字形 */}
      <path d="M6 17 12 5l6 12" />
      <path d="M8.5 13h7" />
      {/* 彩色下划线（独立 fill/stroke，不跟随 currentColor） */}
      <rect x="3" y="20.5" width="18" height="2.2" rx="1" fill="url(#tc-underline)" stroke="none" />
    </svg>
  );
}

/* ---------------- 侧边栏：跨文件搜索 ---------------- */

/** 放大镜：侧边栏「搜索」标签（V3.6 跨文件搜索）。 */
export function SearchIcon({ size, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.5-4.5" />
    </Svg>
  );
}
