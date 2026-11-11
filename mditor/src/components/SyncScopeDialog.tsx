// 同步范围对话框（v5.3）：单个工作区根的自定义同步范围——启用开关、文件
// 类型白名单（跟随默认 / 自定义替换式）、目录树勾选排除（懒加载 readDir，
// 仅目录）、高级通配排除规则。确定时对新旧有效范围做 diff，命中清单里已
// 跟踪的内容时提示「保留孤儿副本 / 同时删除云端副本」——删除走
// pendingPurges 队列（引擎 purge 阶段执行，用户显式确认过，不受批量删除
// 保险拦截）；保留则云端副本成为孤儿对象，不再同步、永不误删。
//
// 语义依据（lib/sync/ignore.ts 头注释）：范围外内容对本端不可见，被排除的
// 已跟踪条目走 deleted|deleted → clearRecord 自然清出清单，本地文件不动。

import { useEffect, useMemo, useRef, useState } from "react";
import { getAdapter, type DirEntry } from "../platform";
import { basename, joinAbs, toPosix } from "../lib/path-shim";
import { readManifest } from "../lib/sync/manifest";
import {
  DEFAULT_SYNCABLE_EXTS,
  isExcludedRelPath,
  isSyncableRelPath,
} from "../lib/sync/ignore";
import { resolveRootScope } from "../lib/sync/engine";
import { SYNC_EXCLUDE_PATTERN_LEN_MAX, SYNC_EXCLUDE_PATTERNS_MAX } from "../settingsNormalize";
import type { RootSyncOptions } from "../types";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";

const EXIT_MS = 240;

/** 确认页列出受影响文件的上限（其余以「…等 N 个」收尾）。 */
const AFFECTED_PREVIEW_MAX = 8;

interface Props {
  open: boolean;
  /** 工作区根绝对路径。 */
  root: string;
  /** 已保存的该根配置（undefined = 全默认行为）。 */
  saved: RootSyncOptions | undefined;
  /**
   * 确定：opts = 新配置（undefined = 回到全默认，键由归一层剔除）；
   * purgeAdditions = 用户新确认「同时删除云端副本」的 relPath 列表（调用方
   * 并入 settings.sync.pendingPurges[root]）。
   */
  onCommit: (opts: RootSyncOptions | undefined, purgeAdditions: string[]) => void;
  onClose: () => void;
}

/** 目录树节点（懒加载：children = null 表示尚未读取）。 */
interface DirNode {
  /** 相对根的 posix 路径；"" = 工作区根本身。 */
  rel: string;
  name: string;
  /** `.` 开头目录——同步引擎恒忽略，展示为禁用态。 */
  hidden: boolean;
  children: DirNode[] | null;
  expanded: boolean;
  loading: boolean;
}

/** 通配规则单条合法性（与归一层/引擎匹配器同一约束面）。 */
function isValidPattern(p: string): boolean {
  if (p === "" || p.length > SYNC_EXCLUDE_PATTERN_LEN_MAX) return false;
  if (p.includes("\\") || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return false;
  }
  return true;
}

/** 选项规范化快照（比较「是否真的改了」用：数组排序、空集剔除）。 */
function canonical(o: RootSyncOptions | undefined): string {
  const c: Record<string, unknown> = {};
  if (o) {
    if (o.enabled === false) c.enabled = false;
    if (o.extensionMode !== undefined) c.extensionMode = o.extensionMode;
    if (o.extensions && o.extensions.length > 0) c.extensions = [...o.extensions].sort();
    if (o.excludedDirs && o.excludedDirs.length > 0) c.excludedDirs = [...o.excludedDirs].sort();
    if (o.excludePatterns && o.excludePatterns.length > 0) {
      c.excludePatterns = [...o.excludePatterns].sort();
    }
  }
  return JSON.stringify(c);
}

/** 有效范围内判定（引擎双侧过滤的同款纯函数，diff 与引擎零语义差）。 */
function makeInScope(opts: RootSyncOptions | undefined): (rel: string) => boolean {
  const scope = resolveRootScope(opts);
  const exts = scope?.exts ?? DEFAULT_SYNCABLE_EXTS;
  const exclude = scope?.exclude;
  return (rel: string) => isSyncableRelPath(rel, exts) && !isExcludedRelPath(rel, exclude);
}

/**
 * 编辑态的有效范围摘要（对话框摘要条 v5.3.1）：当前草稿一眼可读——
 * 类型模式 / 排除目录数 / 规则数。纯函数便于锚定。
 */
function summarizeDraft(
  extMode: "default" | "custom",
  extSet: Set<string>,
  excluded: Set<string>,
  patterns: readonly string[]
): string {
  const parts: string[] = [];
  parts.push(
    extMode === "custom"
      ? `自定义类型 ${extSet.size} 项（${[...extSet].sort().slice(0, 6).join(", ")}${extSet.size > 6 ? "…" : ""}）`
      : "默认类型（md / html / pdf / docx）"
  );
  if (excluded.size > 0) parts.push(`排除 ${excluded.size} 个文件夹`);
  if (patterns.length > 0) parts.push(`${patterns.length} 条规则`);
  return parts.join(" · ");
}

export function SyncScopeDialog({ open, root, saved, onCommit, onClose }: Props) {
  const [enabled, setEnabled] = useState(true);
  const [extMode, setExtMode] = useState<"default" | "custom">("default");
  const [extSet, setExtSet] = useState<Set<string>>(new Set());
  const [newExt, setNewExt] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [patternText, setPatternText] = useState("");
  const [tree, setTree] = useState<DirNode | null>(null);
  /** 编辑页 → 确认页（存在受影响内容时）。 */
  const [affected, setAffected] = useState<string[] | null>(null);
  const [purgeChecked, setPurgeChecked] = useState(false);
  const mounted = useDelayedUnmount(open, EXIT_MS);
  const stateInited = useRef(false);

  // 打开时从已保存配置初始化（编辑中途取消不落任何改动）。
  useEffect(() => {
    if (!open || stateInited.current) return;
    stateInited.current = true;
    setEnabled(saved?.enabled !== false);
    if (saved?.extensionMode === "custom" && saved.extensions && saved.extensions.length > 0) {
      setExtMode("custom");
      setExtSet(new Set(saved.extensions));
    } else {
      setExtMode("default");
      setExtSet(new Set(DEFAULT_SYNCABLE_EXTS));
    }
    setExcluded(new Set(saved?.excludedDirs ?? []));
    setPatternText((saved?.excludePatterns ?? []).join("\n"));
    setTree({ rel: "", name: basename(toPosix(root)) || root, hidden: false, children: null, expanded: true, loading: false });
    setAffected(null);
    setPurgeChecked(false);
    void loadChildren({ rel: "", name: "", hidden: false, children: null, expanded: true, loading: false });
  }, [open, root, saved]);

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
          // 符号链接不入树（与引擎 listLocal 的跳过语义一致；DirEntry 类型
          // 未声明 isSymlink，运行时 Tauri 侧携带）。
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

  /** 不可变更新树中 rel 节点的指定字段。 */
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

  function toggleExpand(node: DirNode): void {
    if (node.hidden) return;
    if (node.children === null && !node.loading) void loadChildren(node);
    setTree((prev) => (prev === null ? prev : updateNode(prev, node.rel, { expanded: !node.expanded })));
  }

  /** 勾选状态（三态）。祖先被排除 → 子树整体视为排除。 */
  function dirState(rel: string): "included" | "excluded" | "partial" {
    if (rel === "") return !enabled ? "excluded" : excluded.size > 0 ? "partial" : "included";
    if (excluded.has(rel)) return "excluded";
    const segs = rel.split("/");
    for (let i = segs.length - 1; i > 0; i--) {
      if (excluded.has(segs.slice(0, i).join("/"))) return "excluded";
    }
    const prefix = `${rel}/`;
    for (const d of excluded) {
      if (d.startsWith(prefix)) return "partial";
    }
    return "included";
  }

  function toggleDir(node: DirNode): void {
    if (node.hidden) return;
    const prefix = `${node.rel}/`;
    if (dirState(node.rel) === "excluded") {
      // 包含：去掉自身与其子树内全部排除项（祖先排除本就覆盖子树）。
      setExcluded((prev) => {
        const next = new Set(prev);
        for (const d of next) {
          if (d === node.rel || d.startsWith(prefix)) next.delete(d);
        }
        return next;
      });
    } else {
      // 排除：记录自身；子树内更细的排除项被前缀语义覆盖，清掉保持干净。
      setExcluded((prev) => {
        const next = new Set(prev);
        for (const d of next) {
          if (d.startsWith(prefix)) next.delete(d);
        }
        next.add(node.rel);
        return next;
      });
    }
  }

  /** 扩展名 chips 的增删（custom 模式下 extSet 即完整白名单）。 */
  function toggleExt(ext: string): void {
    setExtSet((prev) => {
      const next = new Set(prev);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  }

  function addExtInput(): void {
    const parts = newExt.split(/[,\s，、]+/).map((s) => s.trim().toLowerCase().replace(/^\.+/, "")).filter((s) => s !== "");
    if (parts.length === 0) return;
    setExtSet((prev) => {
      const next = new Set(prev);
      for (const p of parts) next.add(p);
      return next;
    });
    setNewExt("");
  }

  const defaultExts = useMemo(() => [...DEFAULT_SYNCABLE_EXTS].sort(), []);
  const extraExts = useMemo(
    () => [...extSet].filter((e) => !DEFAULT_SYNCABLE_EXTS.has(e)).sort(),
    [extSet]
  );

  const patternLines = useMemo(() => patternText.split("\n").map((l) => l.trim()), [patternText]);
  const validPatterns = useMemo(
    () => patternLines.filter((l) => l !== "" && isValidPattern(l)),
    [patternLines]
  );
  const invalidCount = useMemo(
    () => patternLines.filter((l) => l !== "" && !isValidPattern(l)).length,
    [patternLines]
  );

  /** 组装当前编辑态对应的新配置；无任何覆盖时返回 undefined（全默认）。 */
  function buildNext(): RootSyncOptions | undefined {
    const next: RootSyncOptions = {};
    if (!enabled) next.enabled = false;
    if (extMode === "custom" && extSet.size > 0) {
      next.extensionMode = "custom";
      next.extensions = [...extSet].sort();
    }
    if (excluded.size > 0) next.excludedDirs = [...excluded].sort();
    if (validPatterns.length > 0) next.excludePatterns = validPatterns;
    return Object.keys(next).length > 0 ? next : undefined;
  }

  /** 确定第一段：diff 新旧有效范围 ∩ 清单已跟踪键 → 有受影响内容进确认页。 */
  async function beginCommit(): Promise<void> {
    if (invalidCount > 0 || validPatterns.length > SYNC_EXCLUDE_PATTERNS_MAX) return;
    const next = buildNext();
    if (canonical(next) === canonical(saved)) {
      onCommit(saved, []);
      onClose();
      return;
    }
    let manifestFiles: string[];
    try {
      const m = await readManifest(root);
      manifestFiles = m ? Object.keys(m.files) : [];
    } catch {
      manifestFiles = []; // 读不到清单按无已跟踪内容处理（不弹确认）
    }
    const inScopeBefore = makeInScope(saved);
    const inScopeAfter = makeInScope(next);
    const hit = manifestFiles.filter((k) => inScopeBefore(k) && !inScopeAfter(k));
    if (hit.length === 0) {
      onCommit(next, []);
      onClose();
      return;
    }
    setAffected(hit);
    setPurgeChecked(false);
  }

  if (!mounted) return null;

  const editing = affected === null;

  return (
    <div className={`modal-backdrop${open ? "" : " closing"}`} onClick={editing ? onClose : undefined}>
      <div
        className="modal-card sync-scope-card"
        role="dialog"
        aria-label={`同步范围：${basename(toPosix(root)) || root}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{editing ? "同步范围" : "确认同步范围变更"}</h2>
          <span className="sync-scope-root mono" title={root}>
            {basename(toPosix(root)) || root}
          </span>
        </header>

        {editing ? (
          <div className="sync-scope-body">
            <label className="sync-scope-enabled">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>启用此工作区的云同步</span>
            </label>
            <span className="hint">
              关闭后本根完全不参与同步（云端已有副本保留不动，本地文件不受影响）。
            </span>

            <div className={`sync-scope-summary${enabled ? "" : " off"}`} aria-live="polite">
              {enabled
                ? summarizeDraft(extMode, extSet, excluded, validPatterns)
                : "已停用——下方配置不参与同步"}
            </div>

            <div className={`sync-scope-rest${enabled ? "" : " disabled"}`}>
            <div className="sync-scope-block">
              <span className="sync-scope-label">同步文件类型</span>
              <div className="seg" role="radiogroup" aria-label="文件类型模式">
                <button
                  type="button"
                  className={extMode === "default" ? "seg-btn active" : "seg-btn"}
                  onClick={() => setExtMode("default")}
                >
                  跟随默认
                </button>
                <button
                  type="button"
                  className={extMode === "custom" ? "seg-btn active" : "seg-btn"}
                  onClick={() => setExtMode("custom")}
                >
                  自定义
                </button>
              </div>
              {extMode === "custom" && (
                <div className="sync-scope-exts">
                  {[...defaultExts, ...extraExts].map((ext) => (
                    <button
                      key={ext}
                      type="button"
                      className={`sync-scope-chip${extSet.has(ext) ? " on" : ""}`}
                      onClick={() => toggleExt(ext)}
                    >
                      {extSet.has(ext) ? "✓ " : ""}
                      {ext}
                    </button>
                  ))}
                  <span className="sync-scope-ext-add">
                    <input
                      type="text"
                      className="mono"
                      placeholder="追加扩展名，如 png, csv"
                      value={newExt}
                      onChange={(e) => setNewExt(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addExtInput()}
                    />
                    <button type="button" className="btn-ghost" onClick={addExtInput}>
                      添加
                    </button>
                  </span>
                  <span className="hint">
                    自定义为替换式：列表即完整白名单（默认的 md/html/pdf/docx 需要
                    保留就重新勾上）。范围变化后首轮按内容比对衔接，不会误删文件。
                  </span>
                </div>
              )}
            </div>

            <div className="sync-scope-block">
              <span className="sync-scope-label">同步的文件夹</span>
              <div className="sync-scope-tree" role="tree" aria-label="工作区目录树">
                {tree && (
                  <TreeRow
                    node={tree}
                    depth={0}
                    getState={dirState}
                    onToggleExpand={toggleExpand}
                    onToggleDir={toggleDir}
                    onToggleRoot={() => setEnabled((v) => !v)}
                  />
                )}
              </div>
              <span className="hint">
                取消勾选的文件夹不参与同步；「部分包含」表示其下有被排除的子文件夹。
                目录按需加载，新增文件夹默认参与同步。
              </span>
            </div>

            <div className="sync-scope-block">
              <span className="sync-scope-label">高级排除规则（每行一条，可省略）</span>
              <textarea
                className="mono sync-scope-patterns"
                rows={4}
                placeholder={"*.tmp\ntemp/**\nnode_modules"}
                value={patternText}
                onChange={(e) => setPatternText(e.target.value)}
              />
              <span className="hint">
                含「*」的规则按文件名匹配（「*」段内通配、「**」跨层级）：
                「*.tmp」排除任意层级的 .tmp 文件，「temp/**」排除 temp 目录
                全部内容；不含「*」的字面规则按目录匹配：「node_modules」
                排除任意层级的同名目录及其内容。最多 {SYNC_EXCLUDE_PATTERNS_MAX} 条。
                {invalidCount > 0 && (
                  <strong className="sync-scope-warn">
                    {" "}
                    有 {invalidCount} 条规则非法（含 \、..、空段或超长），请修正后再应用。
                  </strong>
                )}
              </span>
            </div>
            </div>
          </div>
        ) : (
          <div className="sync-scope-body">
            <p className="sync-scope-confirm-text">
              本次范围调整将把 <strong>{affected!.length}</strong> 个已同步内容排除在
              同步之外（本地文件不会改动）：
            </p>
            <ul className="sync-scope-affected mono">
              {affected!.slice(0, AFFECTED_PREVIEW_MAX).map((k) => (
                <li key={k}>{k}</li>
              ))}
              {affected!.length > AFFECTED_PREVIEW_MAX && (
                <li>…等共 {affected!.length} 个</li>
              )}
            </ul>
            <label className="sync-scope-enabled">
              <input
                type="checkbox"
                checked={purgeChecked}
                onChange={(e) => setPurgeChecked(e.target.checked)}
              />
              <span>同时从云端删除这些副本</span>
            </label>
            <span className="hint">
              不勾选：云端副本保留为孤儿对象，不再同步、也不删除（安全缺省，随时可
              手动清理）。勾选：删除动作在下一轮同步时执行（需云同步处于启用状态），
              远端删除不可恢复，建议为桶开启版本控制。
            </span>
          </div>
        )}

        <footer className="modal-foot">
          {editing ? (
            <>
              <button className="btn-ghost" onClick={onClose}>
                取消
              </button>
              <button
                className="btn-primary"
                disabled={invalidCount > 0 || validPatterns.length > SYNC_EXCLUDE_PATTERNS_MAX}
                onClick={() => void beginCommit()}
              >
                确定
              </button>
            </>
          ) : (
            <>
              <button className="btn-ghost" onClick={() => setAffected(null)}>
                返回修改
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  onCommit(buildNext(), purgeChecked ? affected! : []);
                  onClose();
                }}
              >
                应用
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/** 树行（递归渲染；三态复选框 + 懒加载展开）。勾选状态由父组件的
 *  dirState 按 excluded 集合推导（含祖先排除覆盖）；根行复选框直接控制
 *  本根启用开关；`.` 目录恒不同步，展示为禁用未勾选。 */
function TreeRow(props: {
  node: DirNode;
  depth: number;
  getState: (rel: string) => "included" | "excluded" | "partial";
  onToggleExpand: (node: DirNode) => void;
  onToggleDir: (node: DirNode) => void;
  onToggleRoot?: () => void;
}) {
  const { node, depth, getState, onToggleExpand, onToggleDir, onToggleRoot } = props;
  const state = getState(node.rel);
  const isRoot = node.rel === "";
  const hasChildren = node.children === null || node.children.length > 0;
  return (
    <>
      <div className={`sync-scope-row${node.hidden ? " hidden-dir" : ""}`} style={{ paddingLeft: depth * 18 }}>
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
          checked={node.hidden ? false : state !== "excluded"}
          ref={(el) => {
            if (el) el.indeterminate = !node.hidden && state === "partial";
          }}
          onChange={() => (isRoot ? onToggleRoot?.() : onToggleDir(node))}
          aria-label={node.name}
        />
        <span className="sync-scope-name" title={isRoot ? node.name : node.rel}>
          {node.name}
        </span>
        {node.hidden && <span className="sync-scope-tag">恒不同步</span>}
        {node.loading && <span className="sync-scope-tag">加载中…</span>}
        {state === "partial" && !node.hidden && <span className="sync-scope-tag">部分包含</span>}
      </div>
      {node.expanded &&
        node.children?.map((c) => (
          <TreeRow
            key={c.rel}
            node={c}
            depth={depth + 1}
            getState={getState}
            onToggleExpand={onToggleExpand}
            onToggleDir={onToggleDir}
          />
        ))}
    </>
  );
}
