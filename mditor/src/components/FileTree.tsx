// Workspace file tree with full management: create / rename / delete files &
// folders, right-click context menu, inline rename, and batch multi-select
// delete.
//
// T4 — LAZY directory expansion: instead of recursively reading the whole
// workspace up front (slow + memory-heavy on large workspaces), only the root
// level is read initially; each directory's children are read on demand the
// first time it is expanded. Centralized state holds:
//   * childrenMap : dir path → its loaded children (root included)
//   * expanded    : set of expanded dir paths
//   * loadingDirs : dirs whose children are currently being read
// FileNode receives its own `expanded`/`childNodes`/`loading` as props (so
// React.memo still skips unchanged siblings) plus stable ref-backed accessors
// to compute its children's props. The active file's ancestor chain is loaded +
// expanded automatically so the open file stays visible.
//
// Performance: FileTree and FileNode are both React.memo'd. `onOpen`/`onChanged`
// are stable callbacks from App (read via refs). Batch/selection props only
// change during management interactions — never while typing in the editor.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import type { CtxEntry } from "./ContextMenu";
import {
  readDirLevel,
  dirOf,
  collectMdPathsFromDisk,
  type TreeNode,
} from "../lib/tauriFs";
import { join } from "../lib/path-shim";
import { prefetchFile } from "../lib/filePrefetch";
import {
  deleteFile,
  deleteDirRecursive,
  createFolder,
  createFile,
  renamePath,
  pathExists,
  validateName,
  withName,
  dedupNestedPaths,
} from "../lib/fileOps";
import {
  NewFileIcon,
  NewFolderIcon,
  RefreshIcon,
  BatchIcon,
  FolderIcon,
  FolderOpenIcon,
  MarkdownFileIcon,
  ChevronRightIcon,
} from "./icons";

/** Notification fired up to App after a tree mutation. */
export type TreeChange =
  | { type: "deleted"; paths: string[] }
  | { type: "renamed"; from: string; to: string };

interface Props {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
  onChanged?: (change: TreeChange) => void;
  /** Absolute paths removed from the workspace tree (kept on disk). */
  excludedPaths: Set<string>;
  /** Remove a file/folder from the workspace tree without deleting it. */
  onExclude?: (path: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  node: TreeNode;
}

export const FileTree = memo(function FileTree({ root, activePath, onOpen, onChanged, excludedPaths, onExclude }: Props) {
  // T4: lazy tree state — dir path → loaded children, the expanded set, and the
  // set of dirs whose children are currently being read (for a "…" placeholder).
  const [childrenMap, setChildrenMap] = useState<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 闪现消息的自动清除定时器：每次 flash 先清前一个，避免批量文件操作 /
  // 监视器刷新突发时堆叠一堆 4s 定时器（各自持有 msg 闭包）。对齐 App.flashStatus。
  const noticeTimerRef = useRef<number | undefined>(undefined);

  // Keep latest callbacks/values in refs so the operation handlers below can
  // have EMPTY dependency arrays (stable identity) and FileNode memo still works.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onExcludeRef = useRef(onExclude);
  onExcludeRef.current = onExclude;
  const excludedPathsRef = useRef(excludedPaths);
  excludedPathsRef.current = excludedPaths;
  // Ref mirrors of the lazy-map state, read inside stable callbacks/effects.
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const loadingDirsRef = useRef(loadingDirs);
  loadingDirsRef.current = loadingDirs;

  // Show a transient message in the tree header; auto-clears after 4s.
  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice((n) => (n === msg ? null : n));
      noticeTimerRef.current = undefined;
    }, 4000);
  }, []);

  // ---- (re)load one level into the centralized map ------------------------
  const reloadDir = useCallback(async (dir: string) => {
    try {
      const entries = await readDirLevel(dir, excludedPathsRef.current);
      setChildrenMap((prev) => {
        const n = new Map(prev);
        n.set(dir, entries);
        return n;
      });
    } catch {
      /* ignore unreadable */
    }
  }, []);

  // Refresh every currently-loaded level (used by the toolbar ↻ button).
  const refreshAll = useCallback(() => {
    const dirs =
      childrenMapRef.current.size > 0
        ? Array.from(childrenMapRef.current.keys())
        : [root];
    (async () => {
      const updates: Array<[string, TreeNode[]]> = [];
      for (const d of dirs) {
        try {
          updates.push([d, await readDirLevel(d, excludedPathsRef.current)]);
        } catch {
          /* ignore */
        }
      }
      setChildrenMap((prev) => {
        const n = new Map(prev);
        for (const [d, e] of updates) n.set(d, e);
        return n;
      });
    })();
  }, [root]);

  // ---- initial load + reload all loaded levels when root/excludedPaths change
  // Always (re)load the root level and refresh any previously-loaded levels that
  // still live under the current root; entries from an OLD workspace are
  // dropped. `childrenMap` is never cleared elsewhere, so without this filter a
  // workspace switch would keep re-reading the *old* root's directories and
  // never load the new one — leaving the tree empty/stale until a manual ↻.
  useEffect(() => {
    let cancelled = false;
    const underRoot = (d: string): boolean =>
      d === root || d.startsWith(root + "/") || d.startsWith(root + "\\");
    (async () => {
      const updates: Array<[string, TreeNode[]]> = [];
      // Always load root first (covers both first mount and workspace switch).
      try {
        updates.push([root, await readDirLevel(root, excludedPaths)]);
      } catch {
        /* ignore unreadable */
      }
      // Reload any other loaded levels still under the new root.
      const loaded = Array.from(childrenMapRef.current.keys()).filter(
        (d) => d !== root && underRoot(d)
      );
      for (const d of loaded) {
        try {
          updates.push([d, await readDirLevel(d, excludedPaths)]);
        } catch {
          /* ignore */
        }
        if (cancelled) return;
      }
      if (cancelled) return;
      setChildrenMap((prev) => {
        const n = new Map<string, TreeNode[]>();
        // keep only entries still under root, then apply the fresh reads
        for (const [k, v] of prev) if (underRoot(k)) n.set(k, v);
        for (const [d, e] of updates) n.set(d, e);
        return n;
      });
      // Drop stale expanded/loading entries that no longer live under root.
      const prune = (prev: Set<string>): Set<string> => {
        let changed = false;
        const n = new Set<string>();
        for (const p of prev) {
          if (underRoot(p)) n.add(p);
          else changed = true;
        }
        return changed ? n : prev;
      };
      setExpanded(prune);
      setLoadingDirs(prune);
    })();
    return () => {
      cancelled = true;
    };
  }, [root, excludedPaths]);

  // ---- auto-load + expand the active file's ancestor chain ----------------
  // So the open file is always reachable in a lazily-loaded tree, walk up from
  // its parent to root: ensure each ancestor's parent level is loaded, then add
  // each ancestor to the expanded set.
  useEffect(() => {
    if (!activePath || !activePath.startsWith(root)) return;
    let cancelled = false;
    (async () => {
      const chain: string[] = [];
      let dir = dirOf(activePath);
      while (
        dir &&
        dir !== root &&
        dir.startsWith(root) &&
        dir.length > root.length
      ) {
        chain.unshift(dir);
        const parent = dirOf(dir);
        if (parent === dir) break; // reached a filesystem root
        dir = parent;
      }
      if (chain.length === 0) return;
      const newChildren: Array<[string, TreeNode[]]> = [];
      const toExpand = new Set<string>();
      for (const ancestor of chain) {
        toExpand.add(ancestor);
        const parent = dirOf(ancestor);
        if (!childrenMapRef.current.has(parent)) {
          try {
            newChildren.push([
              parent,
              await readDirLevel(parent, excludedPathsRef.current),
            ]);
          } catch {
            /* ignore */
          }
        }
        if (cancelled) return;
      }
      if (cancelled) return;
      if (newChildren.length > 0) {
        setChildrenMap((prev) => {
          const n = new Map(prev);
          for (const [p, e] of newChildren) n.set(p, e);
          return n;
        });
      }
      setExpanded((prev) => {
        let changed = false;
        const n = new Set(prev);
        for (const a of toExpand) {
          if (!n.has(a)) {
            n.add(a);
            changed = true;
          }
        }
        return changed ? n : prev;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, root]);

  // path -> node lookup over the LOADED tree, rebuilt only when the map changes.
  const nodeIndex = useMemo(() => {
    const map = new Map<string, TreeNode>();
    const walk = (nodes: TreeNode[] | undefined) => {
      if (!nodes) return;
      for (const n of nodes) {
        map.set(n.path, n);
        if (n.isDir) walk(childrenMap.get(n.path));
      }
    };
    walk(childrenMap.get(root));
    return map;
  }, [childrenMap, root]);

  // ---- expand / collapse (loads children on first expand) -----------------
  const toggleDir = useCallback(
    async (path: string) => {
      if (expandedRef.current.has(path)) {
        setExpanded((prev) => {
          const n = new Set(prev);
          n.delete(path);
          return n;
        });
        return;
      }
      setExpanded((prev) => {
        const n = new Set(prev);
        n.add(path);
        return n;
      });
      if (!childrenMapRef.current.has(path)) {
        setLoadingDirs((prev) => {
          const n = new Set(prev);
          n.add(path);
          return n;
        });
        try {
          const entries = await readDirLevel(path, excludedPathsRef.current);
          setChildrenMap((prev) => {
            const n = new Map(prev);
            n.set(path, entries);
            return n;
          });
        } catch (e) {
          flash(`读取目录失败：${String(e)}`);
        } finally {
          setLoadingDirs((prev) => {
            const n = new Set(prev);
            n.delete(path);
            return n;
          });
        }
      }
    },
    [flash]
  );

  // Stable, ref-backed accessors so every FileNode gets the SAME function
  // identity (memo isn't defeated) while still reading live state.
  const isExpanded = useCallback((p: string) => expandedRef.current.has(p), []);
  const getChildNodes = useCallback(
    (p: string) => childrenMapRef.current.get(p),
    []
  );
  const isLoading = useCallback((p: string) => loadingDirsRef.current.has(p), []);

  // ---- selection (batch mode) ----
  const toggleSelect = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const toggleBatch = useCallback(() => {
    setBatchMode((b) => {
      if (b) setSelected(new Set()); // leaving batch mode clears selection
      return !b;
    });
  }, []);
  // Select every LOADED markdown file/folder (folders included for recursive
  // delete). Lazy/unexpanded folders aren't selectable until expanded; deleting
  // a selected folder still removes its whole subtree on disk.
  const selectAll = useCallback(() => {
    const all: string[] = [];
    const walk = (nodes: TreeNode[] | undefined) => {
      if (!nodes) return;
      for (const n of nodes) {
        all.push(n.path);
        if (n.isDir) walk(childrenMapRef.current.get(n.path));
      }
    };
    walk(childrenMapRef.current.get(root));
    setSelected(new Set(all));
  }, [root]);

  // ---- context menu ----
  const openMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const startRename = useCallback((path: string) => {
    setRenamingPath(path);
    setMenu(null);
  }, []);
  const cancelRename = useCallback(() => setRenamingPath(null), []);

  // ---- delete ----
  // md paths are collected FROM DISK before deletion: the lazy tree may not
  // have a folder's children loaded, and App needs the COMPLETE set to close
  // the buffer (if the open file vanished) and prune the recent list.
  const deleteNode = useCallback(
    async (node: TreeNode) => {
      let mdPaths: string[] = [];
      try {
        mdPaths = await collectMdPathsFromDisk(node.path, node.isDir);
      } catch {
        /* proceed; mdPaths stays [] */
      }
      const inside = node.isDir ? mdPaths.length : 0;
      const label = node.isDir
        ? `文件夹「${node.name}」${inside > 0 ? `（含 ${inside} 个 Markdown 文件）` : ""}`
        : `文件「${node.name}」`;
      if (!confirm(`确定删除${label}？\n此操作不可恢复（永久删除，不进回收站）。`)) return;
      try {
        if (node.isDir) await deleteDirRecursive(node.path);
        else await deleteFile(node.path);
        onChangedRef.current?.({ type: "deleted", paths: mdPaths });
        void reloadDir(dirOf(node.path));
      } catch (e) {
        flash(`删除失败：${String(e)}`);
      }
    },
    [flash, reloadDir]
  );

  // ---- remove from workspace (no disk deletion) ----
  const excludeNode = useCallback(
    (node: TreeNode) => {
      const label = node.isDir ? `文件夹「${node.name}」` : `文件「${node.name}」`;
      if (
        !confirm(
          `确定将${label}从文件树移除？\n（磁盘文件不会被删除，可在 设置 → 已从工作区移除的项目 中恢复）`
        )
      )
        return;
      onExcludeRef.current?.(node.path);
      flash(`已移除${label}（可在设置中恢复）`);
    },
    [flash]
  );

  const batchDelete = useCallback(async () => {
    const paths = dedupNestedPaths(Array.from(selected));
    if (paths.length === 0) return;
    const resolved = paths.map((p) => nodeIndex.get(p));
    const nodes: TreeNode[] = [];
    let dropped = 0;
    for (const n of resolved) {
      if (n) nodes.push(n);
      else dropped++; // a selection can outlive a tree reload that dropped its node
    }
    if (nodes.length === 0) {
      if (dropped > 0) flash(`${dropped} 项已不在树中（可能已被移除），已跳过`);
      return;
    }
    // Complete md-path set from disk so App's buffer/recent cleanup is correct
    // even for folders whose children were never expanded.
    const allMd: string[] = [];
    for (const n of nodes) {
      try {
        allMd.push(...(await collectMdPathsFromDisk(n.path, n.isDir)));
      } catch {
        /* ignore */
      }
    }
    if (
      !confirm(
        `确定删除选中的 ${nodes.length} 项（共 ${allMd.length} 个 Markdown 文件）？\n此操作不可恢复（永久删除，不进回收站）。`
      )
    )
      return;
    const failed: string[] = [];
    const parents = new Set<string>();
    for (const node of nodes) {
      try {
        if (node.isDir) await deleteDirRecursive(node.path);
        else await deleteFile(node.path);
        parents.add(dirOf(node.path));
      } catch {
        failed.push(node.name);
      }
    }
    setSelected(new Set());
    onChangedRef.current?.({ type: "deleted", paths: allMd });
    for (const p of parents) void reloadDir(p);
    if (failed.length > 0) {
      flash(
        `${failed.length} 项删除失败：${failed.slice(0, 5).join("、")}${
          failed.length > 5 ? "…" : ""
        }`
      );
    } else if (dropped > 0) {
      flash(`${dropped} 项已不在树中，已跳过`);
    }
  }, [selected, nodeIndex, flash, reloadDir]);

  // ---- create ----
  const createItem = useCallback(
    async (kind: "file" | "folder", parentDir: string) => {
      const label = kind === "file" ? "Markdown 文件名" : "文件夹名";
      const suggest = kind === "file" ? "untitled.md" : "新建文件夹";
      const input = window.prompt(`输入${label}：`, suggest);
      if (input === null) return; // cancelled
      let name = input.trim();
      const verr = validateName(name);
      if (verr) {
        flash(verr);
        return;
      }
      // Ensure created files are markdown so they show up in the tree.
      if (kind === "file" && !/\.(md|markdown|mdx|mdown)$/i.test(name)) {
        name += ".md";
      }
      const target = join(parentDir, name);
      if (await pathExists(target)) {
        flash(`已存在同名项目：${name}`);
        return;
      }
      try {
        if (kind === "file") await createFile(target);
        else await createFolder(target);
        void reloadDir(parentDir);
      } catch (e) {
        flash(`创建失败：${String(e)}`);
      }
    },
    [flash, reloadDir]
  );

  // ---- rename ----
  const commitRename = useCallback(
    async (node: TreeNode, rawName: string) => {
      setRenamingPath(null);
      const name = rawName.trim();
      if (name === node.name) return; // unchanged
      const verr = validateName(name);
      if (verr) {
        flash(verr);
        return;
      }
      const target = withName(node.path, name);
      if (target === node.path) return;
      if (await pathExists(target)) {
        flash(`已存在同名项目：${name}`);
        return;
      }
      try {
        await renamePath(node.path, target);
        onChangedRef.current?.({ type: "renamed", from: node.path, to: target });
        void reloadDir(dirOf(node.path));
      } catch (e) {
        flash(`重命名失败：${String(e)}`);
      }
    },
    [flash, reloadDir]
  );

  // ---- copy path ----
  const copyPath = useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(path);
        flash("已复制路径");
      } catch {
        flash("复制失败（剪贴板不可用）");
      }
    },
    [flash]
  );

  const openFile = useCallback(
    (path: string) => {
      onOpenRef.current(path);
      setMenu(null);
    },
    []
  );

  const tree = childrenMap.get(root) ?? [];
  const selectedCount = selected.size;

  return (
    <div className="ft-wrap">
      {/* ---- toolbar ---- */}
      <div className="ft-toolbar">
        <button
          className="ft-tool-btn"
          title="新建文件（在工作区根目录）"
          onClick={() => void createItem("file", root)}
        >
          <NewFileIcon size={15} />
        </button>
        <button
          className="ft-tool-btn"
          title="新建文件夹（在工作区根目录）"
          onClick={() => void createItem("folder", root)}
        >
          <NewFolderIcon size={15} />
        </button>
        <button className="ft-tool-btn" title="刷新" onClick={refreshAll}>
          <RefreshIcon size={14} />
        </button>
        <span className="ft-tool-spacer" />
        <button
          className={`ft-tool-btn${batchMode ? " active" : ""}`}
          title={batchMode ? "退出批量模式" : "批量选择模式"}
          onClick={toggleBatch}
        >
          <BatchIcon size={15} />
        </button>
      </div>

      {/* ---- transient notice ---- */}
      {notice && <div className="ft-notice" role="status">{notice}</div>}

      {/* ---- batch action bar ---- */}
      {batchMode && selectedCount > 0 && (
        <div className="ft-batchbar">
          <span className="ft-batch-count">已选 {selectedCount} 项</span>
          <button className="ft-batch-btn" onClick={selectAll}>
            全选
          </button>
          <button className="ft-batch-btn danger" onClick={() => void batchDelete()}>
            删除
          </button>
          <button className="ft-batch-btn" onClick={clearSelection}>
            取消
          </button>
        </div>
      )}

      {/* ---- scrollable tree ---- */}
      <div className="ft-scroll">
        {tree.length === 0 ? (
          <div className="ft-empty">没有 Markdown 文件</div>
        ) : (
          <ul className="ft-root" role="tree">
            {tree.map((n) => (
              <FileNode
                key={n.path}
                node={n}
                depth={0}
                activePath={activePath}
                onOpen={openFile}
                batchMode={batchMode}
                selectedSet={selected}
                renaming={renamingPath === n.path}
                expanded={isExpanded(n.path)}
                childNodes={getChildNodes(n.path)}
                loading={isLoading(n.path)}
                isExpanded={isExpanded}
                getChildNodes={getChildNodes}
                isLoading={isLoading}
                onToggle={toggleDir}
                onToggleSelect={toggleSelect}
                onContext={openMenu}
                onStartRename={startRename}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
              />
            ))}
          </ul>
        )}
      </div>

      {/* ---- right-click context menu ---- */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          entries={treeMenuEntries(menu.node, {
            onOpen: openFile,
            onRename: startRename,
            onDelete: deleteNode,
            onNewFile: (dir) => void createItem("file", dir),
            onNewFolder: (dir) => void createItem("folder", dir),
            onCopyPath: copyPath,
            onExclude: excludeNode,
          })}
        />
      )}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* FileNode                                                                    */
/* -------------------------------------------------------------------------- */

const FileNode = memo(function FileNode({
  node,
  depth,
  activePath,
  onOpen,
  batchMode,
  selectedSet,
  renaming,
  expanded,
  childNodes,
  loading,
  isExpanded,
  getChildNodes,
  isLoading,
  onToggle,
  onToggleSelect,
  onContext,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onOpen: (p: string) => void;
  batchMode: boolean;
  /** The whole selection set — each node checks its own membership. Passed
   * down verbatim so deeply nested children compute their own state (a plain
   * boolean would wrongly inherit the parent's value in the recursion). */
  selectedSet: Set<string>;
  renaming: boolean;
  /** Whether THIS directory is expanded (from centralized state). */
  expanded: boolean;
  /** THIS directory's loaded children (undefined until first expansion). */
  childNodes?: TreeNode[];
  /** True while THIS directory's children are being read. */
  loading: boolean;
  /** Stable, ref-backed accessors used to compute each child's props so memo
   *  only re-renders the branch whose state actually changed. */
  isExpanded: (p: string) => boolean;
  getChildNodes: (p: string) => TreeNode[] | undefined;
  isLoading: (p: string) => boolean;
  onToggle: (p: string) => void;
  onToggleSelect: (p: string) => void;
  onContext: (e: React.MouseEvent, node: TreeNode) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (node: TreeNode, newName: string) => void;
  onCancelRename: () => void;
}) {
  const pad = { paddingLeft: `${depth * 12 + 8}px` };
  const selected = selectedSet.has(node.path);

  const handleRowClick = () => {
    if (batchMode) {
      onToggleSelect(node.path);
      return;
    }
    if (node.isDir) onToggle(node.path);
    else onOpen(node.path);
  };

  if (node.isDir) {
    return (
      <li role="treeitem" aria-expanded={expanded}>
        <div
          className={`ft-row ft-dir${selected && batchMode ? " ft-selected" : ""}`}
          style={pad}
          onClick={handleRowClick}
          onContextMenu={(e) => onContext(e, node)}
        >
          <span
            className="ft-twisty"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
          >
            <ChevronRightIcon size={12} className={`chevron${expanded ? " open" : ""}`} />
          </span>
          {batchMode && (
            <input
              type="checkbox"
              className="ft-check"
              checked={selected}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleSelect(node.path)}
            />
          )}
          <span className="ft-icon">
            {expanded ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />}
          </span>
          {renaming ? (
            <RenameInput
              initial={node.name}
              onCommit={(v) => onCommitRename(node, v)}
              onCancel={onCancelRename}
            />
          ) : (
            <span
              className="ft-name"
              onDoubleClick={(e) => {
                if (!batchMode) {
                  e.stopPropagation();
                  onStartRename(node.path);
                }
              }}
            >
              {node.name}
            </span>
          )}
        </div>
        {expanded && childNodes && childNodes.length > 0 && (
          <ul role="group">
            {childNodes.map((c) => (
              <FileNode
                key={c.path}
                node={c}
                depth={depth + 1}
                activePath={activePath}
                onOpen={onOpen}
                batchMode={batchMode}
                selectedSet={selectedSet}
                renaming={renaming}
                expanded={isExpanded(c.path)}
                childNodes={getChildNodes(c.path)}
                loading={isLoading(c.path)}
                isExpanded={isExpanded}
                getChildNodes={getChildNodes}
                isLoading={isLoading}
                onToggle={onToggle}
                onToggleSelect={onToggleSelect}
                onContext={onContext}
                onStartRename={onStartRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
              />
            ))}
          </ul>
        )}
        {expanded && loading && <div className="ft-loading">…</div>}
      </li>
    );
  }

  const active = node.path === activePath;
  return (
    <li role="treeitem">
      <div
        className={`ft-row ft-file${active ? " ft-active" : ""}${
          selected && batchMode ? " ft-selected" : ""
        }`}
        style={pad}
        onClick={handleRowClick}
        onContextMenu={(e) => onContext(e, node)}
        onPointerEnter={() => prefetchFile(node.path)}
        title={node.path}
      >
        <span className="ft-twisty" />
        {batchMode && (
          <input
            type="checkbox"
            className="ft-check"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(node.path)}
          />
        )}
        <span className="ft-icon">
          <MarkdownFileIcon size={15} />
        </span>
        {renaming ? (
          <RenameInput
            initial={node.name}
            onCommit={(v) => onCommitRename(node, v)}
            onCancel={onCancelRename}
          />
        ) : (
          <span
            className="ft-name"
            onDoubleClick={(e) => {
              if (!batchMode) {
                e.stopPropagation();
                onStartRename(node.path);
              }
            }}
          >
            {node.name}
          </span>
        )}
      </div>
    </li>
  );
});

/* -------------------------------------------------------------------------- */
/* RenameInput — guards against double-commit (Enter → unmount → blur)         */
/* -------------------------------------------------------------------------- */

const RenameInput = memo(function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const doneRef = useRef(false);
  const commit = (v: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(v);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };
  return (
    <input
      className="ft-rename-input"
      defaultValue={initial}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* ContextMenu entries — right-click items for files & directories            */
/* -------------------------------------------------------------------------- */

interface TreeMenuCallbacks {
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (node: TreeNode) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onCopyPath: (path: string) => void;
  onExclude: (node: TreeNode) => void;
}

/** Build the typed entry list for the shared ContextMenu shell. Each entry
 *  carries a stable React key (avoids the "missing key" warning). */
function treeMenuEntries(node: TreeNode, cb: TreeMenuCallbacks): CtxEntry[] {
  const mkItem = (
    key: string,
    label: string,
    fn: () => void,
    danger = false
  ): CtxEntry => ({ kind: "item", key, label, fn, danger });
  const mkSep = (key: string): CtxEntry => ({ kind: "sep", key });

  return node.isDir
    ? [
        mkItem("newfile", "新建文件", () => cb.onNewFile(node.path)),
        mkItem("newfolder", "新建文件夹", () => cb.onNewFolder(node.path)),
        mkSep("s1"),
        mkItem("rename", "重命名", () => cb.onRename(node.path)),
        mkItem("copy", "复制路径", () => void cb.onCopyPath(node.path)),
        mkItem("exclude", "从工作区移除", () => cb.onExclude(node)),
        mkSep("s2"),
        mkItem("delete", "删除", () => void cb.onDelete(node), true),
      ]
    : [
        mkItem("open", "打开", () => cb.onOpen(node.path)),
        mkItem("rename", "重命名", () => cb.onRename(node.path)),
        mkItem("copy", "复制路径", () => void cb.onCopyPath(node.path)),
        mkItem("exclude", "从工作区移除", () => cb.onExclude(node)),
        mkSep("s1"),
        mkItem("delete", "删除", () => void cb.onDelete(node), true),
      ];
}
