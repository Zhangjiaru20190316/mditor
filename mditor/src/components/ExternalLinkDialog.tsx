// 外部关联对话框（v5.3.x）：单个工作区根的「文件状态内外同步」按文件夹
// 配置——根启用开关、根生效类型、懒加载目录树（三态：关联/断开/部分）+
// 选中文件夹的规则详情（开关与类型均可「继承父级」或显式覆盖，就近覆盖
// 语义见 lib/externalLink.ts）。确定时对新旧配置做 canonical 快照比对，
// 无变化不写设置；无确认页——关联开关没有破坏性后果（断开后外部变化只是
// 不再自动反映，手动 ↻ / 重新打开文件随时可见）。

import { useEffect, useRef, useState } from "react";
import { getAdapter, type DirEntry } from "../platform";
import { basename, joinAbs, toPosix } from "../lib/path-shim";
import { resolveLinkScope, toggleFolderRule } from "../lib/externalLink";
import { NOTE_KINDS } from "../defaults";
import { KIND_LABELS } from "./WorkspaceFileDialog";
import type { FolderLinkRule, NoteKind, RootLinkOptions } from "../types";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";

const EXIT_MS = 240;

interface Props {
  open: boolean;
  /** 工作区根绝对路径。 */
  root: string;
  /** 已保存的该根配置（undefined = 全默认：关联 + 全部类型）。 */
  saved: RootLinkOptions | undefined;
  /** 打开时选中的文件夹（相对根 posix 路径；文件树右键入口传入）。 */
  initialDir?: string | null;
  /** 确定：opts = 新配置（undefined = 回到全默认，键由归一层剔除）。 */
  onCommit: (opts: RootLinkOptions | undefined) => void;
  onClose: () => void;
}

/** 目录树节点（懒加载：children = null 表示尚未读取）。 */
interface DirNode {
  /** 相对根的 posix 路径；"" = 工作区根本身。 */
  rel: string;
  name: string;
  /** `.` 开头目录——监听与展示恒忽略，展示为禁用态。 */
  hidden: boolean;
  children: DirNode[] | null;
  expanded: boolean;
  loading: boolean;
}

/** 配置快照（比较「是否真的改了」用：数组排序、键序无关）。 */
function canonical(o: RootLinkOptions | undefined): string {
  const c: Record<string, unknown> = {};
  if (o) {
    if (o.enabled === false) c.enabled = false;
    if (o.fileTypes) c.fileTypes = [...o.fileTypes].sort();
    if (o.folders) {
      const f: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o.folders)) {
        const r: Record<string, unknown> = {};
        if (v.enabled !== undefined) r.enabled = v.enabled;
        if (v.fileTypes) r.fileTypes = [...v.fileTypes].sort();
        f[k] = r;
      }
      c.folders = f;
    }
  }
  return JSON.stringify(c);
}

/** 树节点不可变补丁（SyncScopeDialog 同款）。 */
function updateNode(node: DirNode, rel: string, patch: Partial<DirNode>): DirNode {
  if (node.rel === rel) return { ...node, ...patch };
  if (!node.children) return node;
  let changed = false;
  const children = node.children.map((c) => {
    const next = updateNode(c, rel, patch);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function ExternalLinkDialog({ open, root, saved, initialDir, onCommit, onClose }: Props) {
  // 草稿：enabled/fileTypes 为根级字段，folders 为文件夹显式规则。
  const [enabled, setEnabled] = useState(true);
  const [rootKindMode, setRootKindMode] = useState<"all" | "custom">("all");
  const [rootKinds, setRootKinds] = useState<Set<NoteKind>>(new Set(NOTE_KINDS));
  const [folders, setFolders] = useState<Record<string, FolderLinkRule>>({});
  const [tree, setTree] = useState<DirNode | null>(null);
  /** 详情块正在编辑的文件夹（rel；null = 未选中）。 */
  const [selRel, setSelRel] = useState<string | null>(null);
  const mounted = useDelayedUnmount(open, EXIT_MS);
  const stateInited = useRef(false);

  // 打开时从已保存配置初始化（编辑中途取消不落任何改动）。
  useEffect(() => {
    if (!open || stateInited.current) return;
    stateInited.current = true;
    setEnabled(saved?.enabled !== false);
    if (saved?.fileTypes && saved.fileTypes.length > 0 && saved.fileTypes.length < NOTE_KINDS.length) {
      setRootKindMode("custom");
      setRootKinds(new Set<NoteKind>(saved.fileTypes));
    } else {
      setRootKindMode("all");
      setRootKinds(new Set<NoteKind>(NOTE_KINDS));
    }
    setFolders({ ...(saved?.folders ?? {}) });
    setSelRel(initialDir ?? null);
    setTree({ rel: "", name: basename(toPosix(root)) || root, hidden: false, children: null, expanded: true, loading: false });
    void loadChildren({ rel: "", name: "", hidden: false, children: null, expanded: true, loading: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadChildren 为组件内纯异步助手
  }, [open, root, saved, initialDir]);

  useEffect(() => {
    if (!open) stateInited.current = false;
  }, [open]);

  /** 懒加载某节点的子目录（仅目录；`.` 目录标记 hidden 不再展开）。 */
  async function loadChildren(node: DirNode): Promise<void> {
    const rel = node.rel;
    setTree((prev) => (prev === null ? prev : updateNode(prev, rel, { loading: true })));
    let children: DirNode[] = [];
    try {
      const abs = rel === "" ? root : joinAbs(root, ...rel.split("/"));
      const entries = await getAdapter().fs.readDir(abs);
      const dirs = entries
        .filter((e) => {
          if (!e.isDirectory) return false;
          // 符号链接不入树（与引擎/文件树跳过语义一致）。
          if ((e as DirEntry & { isSymlink?: boolean }).isSymlink) return false;
          return true;
        })
        .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
      children = dirs.map((e) => ({
        rel: rel === "" ? e.name : `${rel}/${e.name}`,
        name: e.name,
        hidden: e.name.startsWith("."),
        children: null,
        expanded: false,
        loading: false,
      }));
    } catch {
      children = []; // 不可读目录按空展开
    }
    setTree((prev) => (prev === null ? prev : updateNode(prev, rel, { children, loading: false })));
  }

  function toggleExpand(node: DirNode): void {
    if (node.hidden) return;
    if (node.children === null && !node.loading) {
      void loadChildren(node);
    }
    setTree((prev) =>
      prev === null ? prev : updateNode(prev, node.rel, { expanded: !node.expanded })
    );
  }

  /** 行三态：有效关联态 + 子树内是否存在与之相反的显式覆盖。 */
  function dirState(rel: string): "linked" | "unlinked" | "partial" {
    const draft: RootLinkOptions = {
      enabled: enabled ? undefined : false,
      fileTypes: rootKindMode === "custom" ? [...rootKinds] : undefined,
      folders,
    };
    const self = resolveLinkScope(draft, rel);
    const prefix = rel === "" ? "" : `${rel}/`;
    for (const k of Object.keys(folders)) {
      if (prefix !== "" && !k.startsWith(prefix)) continue;
      if (resolveLinkScope(draft, k).enabled !== self.enabled) return "partial";
    }
    return self.enabled ? "linked" : "unlinked";
  }

  /** 行复选框快捷切换（与文件树右键快捷项同一 toggleFolderRule 语义）。 */
  function toggleDir(node: DirNode): void {
    if (node.hidden || node.rel === "") return;
    const draft: RootLinkOptions | undefined = buildDraft();
    const next = toggleFolderRule(draft, node.rel);
    applyOpts(next);
  }

  /** 当前草稿 → RootLinkOptions 形态（toggleFolderRule 的输入）。 */
  function buildDraft(): RootLinkOptions | undefined {
    const d: RootLinkOptions = {};
    if (!enabled) d.enabled = false;
    if (rootKindMode === "custom") d.fileTypes = [...rootKinds];
    if (Object.keys(folders).length > 0) d.folders = { ...folders };
    return Object.keys(d).length > 0 ? d : undefined;
  }

  /** toggleFolderRule 产物写回编辑态。 */
  function applyOpts(next: RootLinkOptions | undefined): void {
    setEnabled(next?.enabled !== false);
    if (next?.fileTypes && next.fileTypes.length < NOTE_KINDS.length) {
      setRootKindMode("custom");
      setRootKinds(new Set<NoteKind>(next.fileTypes));
    } else {
      setRootKindMode("all");
      setRootKinds(new Set<NoteKind>(NOTE_KINDS));
    }
    setFolders({ ...(next?.folders ?? {}) });
  }

  /** 详情块：写选中文件夹的显式规则（undefined 字段 = 继承父级）。 */
  function setSelRule(patch: Partial<FolderLinkRule>): void {
    if (selRel === null) return;
    setFolders((prev) => {
      const own: FolderLinkRule = { ...(prev[selRel] ?? {}), ...patch };
      if (own.enabled === undefined && own.fileTypes === undefined) {
        const next = { ...prev };
        delete next[selRel];
        return next;
      }
      return { ...prev, [selRel]: own };
    });
  }

  /** 详情块当前规则（未选中/无显式规则 = 继承）。 */
  const selRule: FolderLinkRule | undefined = selRel !== null ? folders[selRel] : undefined;

  function buildNext(): RootLinkOptions | undefined {
    const next: RootLinkOptions = {};
    if (!enabled) next.enabled = false;
    if (rootKindMode === "custom") next.fileTypes = NOTE_KINDS.filter((k) => rootKinds.has(k));
    const fs: Record<string, FolderLinkRule> = {};
    for (const [k, v] of Object.entries(folders)) {
      const r: FolderLinkRule = {};
      if (v.enabled !== undefined) r.enabled = v.enabled;
      if (v.fileTypes !== undefined) r.fileTypes = [...v.fileTypes];
      if (Object.keys(r).length > 0) fs[k] = r;
    }
    if (Object.keys(fs).length > 0) next.folders = fs;
    return Object.keys(next).length > 0 ? next : undefined;
  }

  function commit(): void {
    const next = buildNext();
    onCommit(canonical(next) === canonical(saved) ? saved : next);
    onClose();
  }

  if (!mounted) return null;

  return (
    <div className={`modal-backdrop${open ? "" : " closing"}`} onClick={onClose}>
      <div
        className="modal-card sync-scope-card"
        role="dialog"
        aria-label={`外部关联：${basename(toPosix(root)) || root}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>外部关联</h2>
          <span className="sync-scope-root mono" title={root}>
            {basename(toPosix(root)) || root}
          </span>
        </header>

        <div className="sync-scope-body">
          <label className="sync-scope-enabled">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>关联此工作区的外部文件状态</span>
          </label>
          <span className="hint">
            关联时，外部（磁盘/其他程序）的文件变化会自动反映到文件树、索引与
            打开的文档；断开后保持安静，手动刷新或重新打开文件可见最新状态。
          </span>

          <div className="sync-scope-block">
            <span className="sync-scope-label">生效文件类型</span>
            <div className="seg" role="radiogroup" aria-label="生效类型模式">
              <button
                type="button"
                className={rootKindMode === "all" ? "seg-btn active" : "seg-btn"}
                onClick={() => setRootKindMode("all")}
              >
                全部类型
              </button>
              <button
                type="button"
                className={rootKindMode === "custom" ? "seg-btn active" : "seg-btn"}
                onClick={() => setRootKindMode("custom")}
              >
                自定义
              </button>
            </div>
            {rootKindMode === "custom" && (
              <div className="sync-scope-exts">
                {NOTE_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`sync-scope-chip${rootKinds.has(k) ? " on" : ""}`}
                    onClick={() =>
                      setRootKinds((prev) => {
                        const n = new Set<NoteKind>(prev);
                        if (n.has(k)) n.delete(k);
                        else n.add(k);
                        return n;
                      })
                    }
                  >
                    {rootKinds.has(k) ? "✓ " : ""}
                    {KIND_LABELS[k]}
                  </button>
                ))}
                <span className="hint">
                  只对所选类型的外部变化作出反应（文件树不显示的类型变化本来
                  就无需反应）。
                </span>
              </div>
            )}
          </div>

          <div className="sync-scope-block">
            <span className="sync-scope-label">按文件夹配置（子文件夹默认继承父级，可就近覆盖）</span>
            <div className="sync-scope-tree" role="tree" aria-label="工作区目录树">
              {tree && (
                <TreeRow
                  node={tree}
                  depth={0}
                  getState={dirState}
                  isCustomized={(rel) => rel !== "" && folders[rel] !== undefined}
                  selectedRel={selRel}
                  onSelect={setSelRel}
                  onToggleExpand={toggleExpand}
                  onToggleDir={toggleDir}
                  onToggleRoot={() => setEnabled((v) => !v)}
                />
              )}
            </div>
            <span className="hint">
              点名称选中文件夹进行精细配置；复选框为快捷开关。「部分」表示其下
              有显式覆盖的子文件夹。目录按需加载。
            </span>
          </div>

          {selRel !== null && (
            <div className="elink-detail">
              <span className="sync-scope-label mono" title={selRel}>
                {selRel} 的规则
              </span>
              <div className="elink-detail-row">
                <span className="elink-detail-label">关联</span>
                <div className="seg" role="radiogroup" aria-label="文件夹关联开关">
                  {(
                    [
                      ["inherit", "继承父级"],
                      ["on", "关联"],
                      ["off", "断开"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      className={
                        (v === "inherit" && selRule?.enabled === undefined) ||
                        (v === "on" && selRule?.enabled === true) ||
                        (v === "off" && selRule?.enabled === false)
                          ? "seg-btn active"
                          : "seg-btn"
                      }
                      onClick={() =>
                        setSelRule({ enabled: v === "inherit" ? undefined : v === "on" })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="elink-detail-row">
                <span className="elink-detail-label">类型</span>
                <div className="seg" role="radiogroup" aria-label="文件夹生效类型">
                  {(
                    [
                      ["inherit", "继承父级"],
                      ["all", "全部类型"],
                      ["custom", "自定义"],
                    ] as const
                  ).map(([v, label]) => {
                    const mode =
                      selRule?.fileTypes === undefined
                        ? "inherit"
                        : selRule.fileTypes.length >= NOTE_KINDS.length
                          ? "all"
                          : "custom";
                    return (
                      <button
                        key={v}
                        type="button"
                        className={mode === v ? "seg-btn active" : "seg-btn"}
                        onClick={() =>
                          setSelRule({
                            fileTypes:
                              v === "inherit"
                                ? undefined
                                : v === "all"
                                  ? [...NOTE_KINDS]
                                  : NOTE_KINDS.filter((k) => selRule?.fileTypes?.includes(k) ?? false),
                          })
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {selRule?.fileTypes !== undefined && selRule.fileTypes.length < NOTE_KINDS.length && (
                <div className="sync-scope-exts">
                  {NOTE_KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`sync-scope-chip${selRule.fileTypes!.includes(k) ? " on" : ""}`}
                      onClick={() => {
                        const cur = new Set<NoteKind>(selRule.fileTypes ?? []);
                        if (cur.has(k)) cur.delete(k);
                        else cur.add(k);
                        setSelRule({ fileTypes: [...cur] });
                      }}
                    >
                      {selRule.fileTypes!.includes(k) ? "✓ " : ""}
                      {KIND_LABELS[k]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={commit}>
            确定
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 树行（递归渲染；三态复选框 + 懒加载展开 + 点名称选中）。复选框为快捷
 *  开关（toggleFolderRule 语义）；根行复选框直接控制本根启用开关；`.`
 *  目录恒忽略，展示为禁用态。 */
function TreeRow(props: {
  node: DirNode;
  depth: number;
  getState: (rel: string) => "linked" | "unlinked" | "partial";
  isCustomized: (rel: string) => boolean;
  selectedRel: string | null;
  onSelect: (rel: string) => void;
  onToggleExpand: (node: DirNode) => void;
  onToggleDir: (node: DirNode) => void;
  onToggleRoot?: () => void;
}) {
  const {
    node,
    depth,
    getState,
    isCustomized,
    selectedRel,
    onSelect,
    onToggleExpand,
    onToggleDir,
    onToggleRoot,
  } = props;
  const state = getState(node.rel);
  const isRoot = node.rel === "";
  const hasChildren = node.children === null || node.children.length > 0;
  return (
    <>
      <div
        className={`sync-scope-row${node.hidden ? " hidden-dir" : ""}${
          selectedRel === node.rel ? " selected" : ""
        }`}
        style={{ paddingLeft: depth * 18 }}
      >
        {node.hidden || !hasChildren ? (
          <span className="sync-scope-twist sync-scope-twist-blank" />
        ) : (
          <button
            type="button"
            className="sync-scope-twist"
            aria-label={node.expanded ? "收起" : "展开"}
            onClick={() => onToggleExpand(node)}
          >
            {node.expanded ? "▾" : "▸"}
          </button>
        )}
        <input
          type="checkbox"
          disabled={node.hidden}
          checked={node.hidden ? false : state !== "unlinked"}
          ref={(el) => {
            if (el) el.indeterminate = !node.hidden && state === "partial";
          }}
          onChange={() => (isRoot ? onToggleRoot?.() : onToggleDir(node))}
          aria-label={node.name}
        />
        <button
          type="button"
          className="sync-scope-name elink-name"
          title={isRoot ? node.name : node.rel}
          onClick={() => !isRoot && onSelect(node.rel)}
        >
          {node.name}
        </button>
        {node.hidden && <span className="sync-scope-tag">恒忽略</span>}
        {node.loading && <span className="sync-scope-tag">加载中…</span>}
        {state === "partial" && !node.hidden && <span className="sync-scope-tag">部分</span>}
        {isCustomized(node.rel) && <span className="sync-scope-tag">已自定义</span>}
        {selectedRel === node.rel && <span className="sync-scope-tag">编辑中</span>}
      </div>
      {node.expanded &&
        node.children?.map((c) => (
          <TreeRow
            key={c.rel}
            node={c}
            depth={depth + 1}
            getState={getState}
            isCustomized={isCustomized}
            selectedRel={selectedRel}
            onSelect={onSelect}
            onToggleExpand={onToggleExpand}
            onToggleDir={onToggleDir}
          />
        ))}
    </>
  );
}
