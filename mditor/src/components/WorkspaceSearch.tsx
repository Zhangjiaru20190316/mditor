// 侧边栏「搜索」面板（V3.6 跨文件搜索）：在当前工作区递归扫描 .md 文件，
// 按行匹配 query，按文件分组展示；点击命中行打开文件并跳到对应位置。
//
// 输入 300ms 防抖后自动搜索（复用上一次结果不重扫）；显示扫描/命中统计与
// 截断提示（见 lib/workspaceSearch 的上限说明）。React.memo：App 打字期间
// 重渲染频繁，本面板只在自身状态变化时渲染。

import { memo, useEffect, useRef, useState } from "react";
import {
  searchWorkspace,
  type FileHits,
  type WorkspaceSearchResult,
} from "../lib/workspaceSearch";
import type { SearchHit } from "../lib/workspaceSearch";

interface Props {
  /** 工作区根目录；null 时显示空态。 */
  workspace: string | null;
  /** 「从工作区移除」的路径集合。 */
  excludedPaths: Set<string>;
  /** 打开文件并跳到命中行（App 负责打开标签页与定位）。 */
  onOpenResult: (path: string, hit: SearchHit) => void;
}

/** 最多直接渲染的命中行数（超出显示提示，避免一次挂几千行 DOM）。 */
const MAX_RENDERED_HITS = 300;

const EMPTY: WorkspaceSearchResult = {
  files: [],
  scanned: 0,
  totalHits: 0,
  truncated: false,
};

export const WorkspaceSearch = memo(function WorkspaceSearch({
  workspace,
  excludedPaths,
  onOpenResult,
}: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<WorkspaceSearchResult>(EMPTY);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  // 上一次实际执行搜索的 (query, caseSensitive)，避免无关重渲染触发重扫。
  const lastSearchRef = useRef("");

  useEffect(() => {
    const q = query.trim();
    if (!workspace || !q) {
      setResult(EMPTY);
      setSearched(false);
      lastSearchRef.current = "";
      return;
    }
    const key = `${caseSensitive ? "A" : "a"}:${q}`;
    if (lastSearchRef.current === key) return;
    const timer = window.setTimeout(() => {
      lastSearchRef.current = key;
      setSearching(true);
      searchWorkspace(workspace, q, { caseSensitive, excluded: excludedPaths })
        .then((r) => {
          setResult(r);
          setSearched(true);
        })
        .catch(() => {
          setResult(EMPTY);
          setSearched(true);
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, caseSensitive, workspace, excludedPaths]);

  // 展示上限：截到 MAX_RENDERED_HITS 行。
  let rendered = 0;
  const filesShown: FileHits[] = [];
  for (const f of result.files) {
    if (rendered >= MAX_RENDERED_HITS) break;
    const room = MAX_RENDERED_HITS - rendered;
    filesShown.push({
      ...f,
      hits: f.hits.slice(0, room),
    });
    rendered += Math.min(f.hits.length, room);
  }

  return (
    <div className="ws-panel">
      <div className="ws-input-row">
        <input
          className="ws-input"
          placeholder={workspace ? "在工作区文件中搜索…" : "先打开一个文件夹"}
          value={query}
          disabled={!workspace}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
        <button
          className={`ws-toggle${caseSensitive ? " active" : ""}`}
          title="区分大小写"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
      </div>

      {searching && <div className="ws-status">搜索中…</div>}

      {!searching && searched && query.trim() && (
        <div className="ws-status">
          {result.totalHits} 处命中 · {result.files.length} 个文件 · 扫描{" "}
          {result.scanned} 个文件
          {(result.truncated || result.totalHits > rendered) && "（结果已截断）"}
        </div>
      )}

      <div className="ws-results">
        {filesShown.map((f) => (
          <div key={f.path} className="ws-file">
            <div className="ws-file-name" title={f.path}>
              {f.name}
              <span className="ws-file-count">{f.hits.length}</span>
            </div>
            {f.hits.map((h) => (
              <button
                key={`${h.line}-${h.col}`}
                className="ws-hit"
                title={`第 ${h.line + 1} 行 · ${f.path}`}
                onClick={() => onOpenResult(f.path, h)}
              >
                <span className="ws-hit-line">{h.line + 1}</span>
                <span className="ws-hit-text">{h.text.trim() || "(空行)"}</span>
              </button>
            ))}
          </div>
        ))}
        {!searching && searched && result.files.length === 0 && query.trim() && (
          <div className="ws-empty">没有匹配的文件</div>
        )}
        {!searched && (
          <div className="ws-empty">
            {workspace
              ? "输入关键词，在工作区所有 Markdown 文件中搜索"
              : "打开文件夹后即可跨文件搜索"}
          </div>
        )}
      </div>
    </div>
  );
});
