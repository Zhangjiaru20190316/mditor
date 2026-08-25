// Workspace file tree with full management: create / rename / delete files &
// folders, right-click context menu, inline rename, and batch multi-select
// delete.
//
// V4.4 — MULTI-ROOT: the tree renders one collapsible section per workspace
// root (VS Code style). All lazy state (childrenMap / expanded / loadingDirs)
// is keyed by absolute path, which is unique across roots — so per-section
// expansion survives adding/removing other roots, and the prune effect only
// drops entries no longer under ANY root.
//
// T4 — LAZY directory expansion: instead of recursively reading the whole
// workspace up front (slow + memory-heavy on large workspaces), only the root
// level is read initially; each directory's children are read on demand the
// first time it is expanded. Centralized state holds:
//   * childrenMap : dir path → its loaded children (roots included)
//   * expanded    : set of expanded dir paths
//   * loadingDirs : dirs whose children are currently being read
// FileNode reads its own `expanded`/`childNodes`/`loading` via
// useSyncExternalStore subscriptions on that centralized state (notified
// after every FileTree render): toggling a folder deep in the tree re-renders
// exactly the affected row, and React.memo still skips unchanged siblings.
// (v4.0.0 — these three used to be props computed inside the PARENT row's
// render; when a deeper folder toggled, the parent's own props were unchanged
// so its memo skip froze the whole subtree: depth ≥ 2 folders expanded in
// state but never visibly.) The active file's ancestor chain is loaded +
// expanded automatically so the open file stays visible.
//
// Performance: FileTree and FileNode are both React.memo'd. `onOpen`/`onChanged`
// are stable callbacks from App (read via refs). Batch/selection props only
// change during management interactions — never while typing in the editor.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ContextMenu } from "./ContextMenu";
import type { CtxEntry } from "./ContextMenu";
import {
  readDirLevel,
  dirOf,
  collectMdPathsFromDisk,
  type TreeNode,
} from "../lib/tauriFs";
import { join, basename } from "../lib/path-shim";
import {
  isUnderRoot as isUnderPath,
  samePathFold as samePath,
  rootOf,
} from "../lib/workspaces";
import { prefetchFile } from "../lib/filePrefetch";
import { confirmDialog } from "../lib/dialogs";
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
  CloseIcon,
} from "./icons";

/** Notification fired up to App after a tree mutation. */
export type TreeChange =
  | { type: "deleted"; paths: string[] }
  | { type: "renamed"; from: string; to: string };

/** Shallow entry-list equality (identity, length, path/name/isDir per row) —
 *  lets reload paths that found NO change keep the previous Map entry (and
 *  the memo'd subtree references) instead of re-rendering the whole tree. */
function sameEntries(a: TreeNode[], b: TreeNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].path !== b[i].path ||
      a[i].name !== b[i].name ||
      a[i].isDir !== b[i].isDir
    ) {
      return false;
    }
  }
  return true;
}

/** Directories with more children than this mount incrementally (a「显示更
 *  多」row reveals the next chunk). Guards the DOM explosion of expanding a
 *  several-thousand-file directory in one shot. */
const CHILD_CHUNK = 300;

interface Props {
  /** 工作区根目录列表（多根，V4.4）。空列表时组件不该被渲染（App 显示空态）。 */
  roots: string[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onChanged?: (change: TreeChange) => void;
  /** Absolute paths removed from the workspace tree (kept on disk). */
  excludedPaths: Set<string>;
  /** Remove a file/folder from the workspace tree without deleting it. */
  onExclude?: (path: string) => void;
  /** 把一个根从工作区移除（多根区头的 ×；磁盘不受影响，App 负责持久化）。 */
  onRemoveRoot?: (root: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  node: TreeNode;
}

export const FileTree = memo(function FileTree({ roots, activePath, onOpen, onChanged, excludedPaths, onExclude, onRemoveRoot }: Props) {
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
  // 多根分区折叠状态（根路径集合）：折叠只是不渲染该区行，childrenMap/
  // expanded 全部保留 —— 再展开零 IO、状态原样恢复。
  const [sectionCollapsed, setSectionCollapsed] = useState<Set<string>>(new Set());
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
  const onRemoveRootRef = useRef(onRemoveRoot);
  onRemoveRootRef.current = onRemoveRoot;
  const excludedPathsRef = useRef(excludedPaths);
  excludedPathsRef.current = excludedPaths;
  // Ref mirrors of the lazy-map state, read inside stable callbacks/effects.
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const loadingDirsRef = useRef(loadingDirs);
  loadingDirsRef.current = loadingDirs;
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  // Effects depend on this JOINED key, not the array identity: App re-renders
  // would otherwise re-run the load effect on every render for an identical
  // root list (the array is rebuilt by state updates even when unchanged).
  const rootsKey = roots.join("\n");

  // ---- row-level state subscription (v4.0.0) -------------------------------
  // Nested rows' expanded / childNodes / loading derive from the centralized
  // state above. Computing them as props inside the PARENT row's render let
  // the parent's React.memo skip freeze every deeper level: a depth ≥ 2 toggle
  // changed no prop of the intermediate rows, so their subtrees never
  // re-rendered and the click looked dead. Rows now subscribe directly —
  // FileTree notifies subscribers after each of its renders (any useState
  // change re-renders it), and each row's snapshots are primitives /
  // identity-stable arrays, so only the row(s) whose OWN state changed
  // re-render. Sibling memo behavior is untouched.
  const rowListenersRef = useRef(new Set<() => void>());
  const subscribeRow = useCallback((fn: () => void) => {
    rowListenersRef.current.add(fn);
    return () => {
      rowListenersRef.current.delete(fn);
    };
  }, []);
  useEffect(() => {
    for (const fn of rowListenersRef.current) fn();
  });

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
        const old = prev.get(dir);
        // Unchanged listing → keep the previous Map (and every memo'd subtree
        // reference) instead of re-rendering the whole tree for a no-op.
        if (old && sameEntries(old, entries)) return prev;
        const n = new Map(prev);
        n.set(dir, entries);
        return n;
      });
    } catch {
      /* ignore unreadable */
    }
  }, []);

  // Refresh every currently-loaded level (used by the toolbar ↻ button).
  // Reads run in PARALLEL (serializing N loaded dirs cost N sequential IPC
  // round-trips), and a token guards against an older refresh's results
  // landing after a newer one's and clobbering them.
  const refreshTokenRef = useRef(0);
  const refreshAll = useCallback(() => {
    const dirs =
      childrenMapRef.current.size > 0
        ? Array.from(childrenMapRef.current.keys())
        : [...rootsRef.current];
    const token = ++refreshTokenRef.current;
    void (async () => {
      const results = await Promise.allSettled(
        dirs.map((d) => readDirLevel(d, excludedPathsRef.current))
      );
      if (token !== refreshTokenRef.current) return; // superseded by a newer ↻
      const updates: Array<[string, TreeNode[]]> = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") updates.push([dirs[i], r.value]);
      });
      setChildrenMap((prev) => {
        let changed = false;
        const n = new Map(prev);
        for (const [d, e] of updates) {
          const old = prev.get(d);
          if (old && sameEntries(old, e)) continue;
          changed = true;
          n.set(d, e);
        }
        return changed ? n : prev;
      });
    })();
  }, []);

  // ---- initial load + reload all loaded levels when roots/excludedPaths change
  // Always (re)load EVERY root's top level and refresh any previously-loaded
  // levels that still live under one of the current roots; entries from roots
  // that were REMOVED are dropped. `childrenMap` is never cleared elsewhere, so
  // without this filter removing a root would keep re-reading its directories —
  // while other roots' expansion state must survive untouched (underAnyRoot).
  useEffect(() => {
    let cancelled = false;
    const roots = rootsRef.current;
    const underAnyRoot = (d: string): boolean => roots.some((r) => isUnderPath(d, r));
    (async () => {
      const updates: Array<[string, TreeNode[]]> = [];
      // Always load every root's top level (covers first mount AND root-list
      // changes: additions get their level, removals are pruned below).
      for (const r of roots) {
        try {
          updates.push([r, await readDirLevel(r, excludedPaths)]);
        } catch {
          /* ignore unreadable */
        }
        if (cancelled) return;
      }
      // Reload any other loaded levels still under one of the current roots.
      const loaded = Array.from(childrenMapRef.current.keys()).filter(
        (d) => !roots.some((r) => samePath(d, r)) && underAnyRoot(d)
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
        // keep only entries still under one of the roots, then apply fresh reads
        for (const [k, v] of prev) if (underAnyRoot(k)) n.set(k, v);
        for (const [d, e] of updates) n.set(d, e);
        return n;
      });
      // Drop stale expanded/loading entries that no longer live under any root.
      const prune = (prev: Set<string>): Set<string> => {
        let changed = false;
        const n = new Set<string>();
        for (const p of prev) {
          if (underAnyRoot(p)) n.add(p);
          else changed = true;
        }
        return changed ? n : prev;
      };
      setExpanded(prune);
      setLoadingDirs(prune);
      // A removed root's section-collapse flag is stale by definition.
      setSectionCollapsed((prev) => {
        const n = new Set<string>();
        for (const p of prev) if (underAnyRoot(p)) n.add(p);
        return n.size === prev.size ? prev : n;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [rootsKey, excludedPaths]);

  // ---- auto-load + expand the active file's ancestor chain ----------------
  // So the open file is always reachable in a lazily-loaded tree, walk up from
  // its parent to the root that CONTAINS it (multi-root: any of them), ensure
  // each ancestor's parent level is loaded, then add each ancestor to the
  // expanded set.
  useEffect(() => {
    const root = activePath ? rootOf(activePath, rootsRef.current) : null;
    if (!activePath || !root) return;
    let cancelled = false;
    (async () => {
      const chain: string[] = [];
      let dir = dirOf(activePath);
      // Walk up to (but excluding) root. samePath/isUnderPath are
      // case-insensitive: the dialog and the watcher routinely return the
      // same directory with different casing on Windows.
      while (dir && !samePath(dir, root) && isUnderPath(dir, root)) {
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
    // rootsKey：根列表变化（如新根包含活动文件）时需要重走祖先链。
  }, [activePath, rootsKey]);

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
    for (const r of roots) walk(childrenMap.get(r));
    return map;
  }, [childrenMap, roots]);

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
  // Ref mirror + stable accessor: rows receive a plain `selected` boolean and
  // compute their children's via isSelected — the previous whole-Set prop
  // busted EVERY row's memo on every click (new Set identity per toggle).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const isSelected = useCallback((p: string) => selectedRef.current.has(p), []);
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
    for (const r of rootsRef.current) walk(childrenMapRef.current.get(r));
    setSelected(new Set(all));
  }, []);

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
      if (
        !(await confirmDialog(
          `确定删除${label}？\n此操作不可恢复（永久删除，不进回收站）。`
        ))
      )
        return;
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
      void (async () => {
        if (
          !(await confirmDialog(
            `确定将${label}从文件树移除？\n（磁盘文件不会被删除，可在 设置 → 已从工作区移除的项目 中恢复）`
          ))
        )
          return;
        onExcludeRef.current?.(node.path);
        flash(`已移除${label}（可在设置中恢复）`);
      })();
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
      !(await confirmDialog(
        `确定删除选中的 ${nodes.length} 项（共 ${allMd.length} 个 Markdown 文件）？\n此操作不可恢复（永久删除，不进回收站）。`
      ))
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

  // ---- multi-root sections ---------------------------------------------------
  const toggleSection = useCallback((root: string) => {
    setSectionCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(root)) n.delete(root);
      else n.add(root);
      return n;
    });
  }, []);

  /** 工具栏「在工作区根目录新建」的目标根：活动文件所属根，否则第一个根。 */
  const targetRoot =
    (activePath ? rootOf(activePath, roots) : null) ?? roots[0] ?? "";
  const targetName = targetRoot ? basename(targetRoot) || targetRoot : "";

  const selectedCount = selected.size;

  return (
    <div className="ft-wrap">
      {/* ---- toolbar ---- */}
      <div className="ft-toolbar">
        <button
          className="ft-tool-btn"
          title={`新建文件（在 ${targetName} 中）`}
          disabled={!targetRoot}
          onClick={() => void createItem("file", targetRoot)}
        >
          <NewFileIcon size={15} />
        </button>
        <button
          className="ft-tool-btn"
          title={`新建文件夹（在 ${targetName} 中）`}
          disabled={!targetRoot}
          onClick={() => void createItem("folder", targetRoot)}
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

      {/* ---- scrollable tree: one collapsible section per root ---- */}
      <div className="ft-scroll">
        {roots.map((r) => {
          const collapsed = sectionCollapsed.has(r);
          const rows = childrenMap.get(r) ?? [];
          return (
            <section key={r} className={`ft-section${collapsed ? " collapsed" : ""}`}>
              <div
                className="ft-section-head"
                title={r}
                onClick={() => toggleSection(r)}
              >
                <ChevronRightIcon
                  size={12}
                  className={`chevron${collapsed ? "" : " open"}`}
                />
                <FolderIcon size={14} className="ft-section-ico" />
                <span className="ft-section-name">{basename(r) || r}</span>
                {onRemoveRoot && (
                  <button
                    className="ft-section-x"
                    title="从工作区移除此文件夹（磁盘文件不受影响）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveRootRef.current?.(r);
                    }}
                  >
                    <CloseIcon size={11} />
                  </button>
                )}
              </div>
              {!collapsed &&
                (rows.length === 0 ? (
                  <div className="ft-empty">没有 Markdown 文件</div>
                ) : (
                  <ul className="ft-root" role="tree">
                    {rows.map((n) => (
                      <FileNode
                        key={n.path}
                        node={n}
                        depth={0}
                        activePath={activePath}
                        onOpen={openFile}
                        batchMode={batchMode}
                        selected={selected.has(n.path)}
                        isSelected={isSelected}
                        renamingPath={renamingPath}
                        isExpanded={isExpanded}
                        getChildNodes={getChildNodes}
                        isLoading={isLoading}
                        subscribeRow={subscribeRow}
                        onToggle={toggleDir}
                        onToggleSelect={toggleSelect}
                        onContext={openMenu}
                        onStartRename={startRename}
                        onCommitRename={commitRename}
                        onCancelRename={cancelRename}
                      />
                    ))}
                  </ul>
                ))}
            </section>
          );
        })}
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
  selected,
  isSelected,
  renamingPath,
  isExpanded,
  getChildNodes,
  isLoading,
  subscribeRow,
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
  /** THIS row's own selection state (batch mode). Children compute theirs
   *  through the stable `isSelected` accessor — passing the whole Set (as
   *  this used to) busted every row's memo on every click. */
  selected: boolean;
  isSelected: (p: string) => boolean;
  /** The path being renamed right now (primitive, so unrelated rows' memo
   *  comparisons stay cheap and never propagate a parent's renaming state to
   *  its descendants — the old boolean `renaming` prop gave every descendant
   *  of a renamed directory its own autoFocus input). */
  renamingPath: string | null;
  /** Stable, ref-backed accessors over the centralized lazy-tree state. Each
   *  row reads its OWN expanded / children / loading through them (see the
   *  subscriptions below) and passes them on so children can do the same. */
  isExpanded: (p: string) => boolean;
  getChildNodes: (p: string) => TreeNode[] | undefined;
  isLoading: (p: string) => boolean;
  /** Stable subscription into FileTree's post-render row notification. */
  subscribeRow: (fn: () => void) => () => void;
  onToggle: (p: string) => void;
  onToggleSelect: (p: string) => void;
  onContext: (e: React.MouseEvent, node: TreeNode) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (node: TreeNode, newName: string) => void;
  onCancelRename: () => void;
}) {
  const pad = { paddingLeft: `${depth * 12 + 8}px` };
  const renaming = renamingPath === node.path;
  // Chunked mounting for huge directories (see CHILD_CHUNK): reveal more on
  // demand instead of mounting thousands of rows the moment the dir expands.
  const [visibleCount, setVisibleCount] = useState(CHILD_CHUNK);
  // Own-state subscriptions (v4.0.0): this row re-renders when ITS expanded /
  // loaded children / loading flag changes, however deep it sits — the old
  // props-from-parent scheme froze subtrees under any memo-skipped ancestor,
  // so depth ≥ 2 folders never visibly expanded. Snapshots are booleans or
  // identity-stable arrays, so unrelated rows stay skipped by memo.
  const expanded = useSyncExternalStore(
    subscribeRow,
    () => isExpanded(node.path)
  );
  const childNodes = useSyncExternalStore(
    subscribeRow,
    () => getChildNodes(node.path)
  );
  const loading = useSyncExternalStore(
    subscribeRow,
    () => isLoading(node.path)
  );

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
            {childNodes.slice(0, visibleCount).map((c) => (
              <FileNode
                key={c.path}
                node={c}
                depth={depth + 1}
                activePath={activePath}
                onOpen={onOpen}
                batchMode={batchMode}
                selected={isSelected(c.path)}
                isSelected={isSelected}
                renamingPath={renamingPath}
                isExpanded={isExpanded}
                getChildNodes={getChildNodes}
                isLoading={isLoading}
                subscribeRow={subscribeRow}
                onToggle={onToggle}
                onToggleSelect={onToggleSelect}
                onContext={onContext}
                onStartRename={onStartRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
              />
            ))}
            {childNodes.length > visibleCount && (
              <li className="ft-more" role="presentation">
                <button
                  className="ft-more-btn"
                  style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
                  onClick={() => setVisibleCount((v) => v + CHILD_CHUNK)}
                >
                  显示更多（还有 {childNodes.length - visibleCount} 项）
                </button>
              </li>
            )}
          </ul>
        )}
        {expanded && loading && <div className="ft-loading">…</div>}
      </li>
    );
  }

  // Case-insensitive: the tree's paths and App's activePath can differ in
  // casing on Windows depending on which subsystem produced them.
  const active = samePath(node.path, activePath ?? "");
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
