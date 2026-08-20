// 诊断面板（v3.9.3 批注 / v3.9.4 滚动）——批注链路与滚动链路的运行时观测台。
//
// 连续几轮「徽章无编号 / 代码块连片闪」修复后仍复发，缺的不是猜想而是
// 运行时证据：定点写成败分布、整篇回退的频率与来源、盖章轮次、内存
// 重建。面板实时展示 lib/annoDebug 的事件流与计数器，并提供「批注体检」
// ——用真实 Milkdown 解析器（探针经 useMilkdown 注册）对当前文档逐条
// 核查「文本层 → PM 节点层 → DOM 层 → 真实解析器层」，历史上字符串级
// 测试全绿但真实解析器丢弃定义形态的事故由此可直接读出。
//
// v3.9.4 起同时展示 lib/scrollDebug 的滚动证据：滚动会话归因（用户 /
// 程序写入 / ghost「页面自己动」）、视口内容位移、文档高度突变、长任务
// ——与批注事件按时间合并展示（滚动异常常与批注/盖章/重建联动，交错时
// 间线是定位的关键）。
//
// 开启方式：设置 → 「批注诊断面板」，或 Ctrl+Alt+D。默认关闭，关闭时
// 零渲染开销（App 条件挂载）；事件总线常驻（环形缓冲 300 条，永远可以
// 打开面板回看最近发生了什么）。

import { memo, useCallback, useEffect, useReducer, useState } from "react";
import {
  annoCounters,
  annoDebugClear,
  annoEvents,
  annoSubscribe,
  runAnnoHealthCheck,
  type AnnoHealthRow,
} from "../lib/annoDebug";
import {
  scrollCounters,
  scrollDebugClear,
  scrollEvents,
  scrollSubscribe,
  scrollWatchStats,
} from "../lib/scrollDebug";
import type { Theme } from "../types";

interface Props {
  /** 实时读取当前文档 markdown（体检用；调用频率=点击体检按钮）。 */
  getMarkdown: () => string;
  /** 关闭面板（写回设置项）。 */
  onClose: () => void;
  theme: Theme;
}

const VERDICT_LABEL: Record<string, string> = {
  pass: "✓",
  fail: "✗",
  "n/a": "–",
  true: "✓",
  false: "✗",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const AnnoDiagnostics = memo(function AnnoDiagnostics({
  getMarkdown,
  onClose,
}: Props) {
  // 事件到达即重渲染（订阅推送；计数器/事件都从总线快照读取）。
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const un1 = annoSubscribe(bump);
    const un2 = scrollSubscribe(bump);
    return () => {
      un1();
      un2();
    };
  }, []);

  const [health, setHealth] = useState<AnnoHealthRow[] | null>(null);
  const [healthAt, setHealthAt] = useState<number | null>(null);

  const runHealth = useCallback(() => {
    setHealth(runAnnoHealthCheck(getMarkdown()));
    setHealthAt(Date.now());
  }, [getMarkdown]);

  const clearAll = useCallback(() => {
    annoDebugClear();
    scrollDebugClear();
  }, []);

  const copyReport = useCallback(() => {
    const lines: string[] = [];
    lines.push(`# mditor 诊断（批注+滚动）@ ${new Date().toISOString()}`);
    lines.push("## 批注计数器");
    for (const [k, v] of Object.entries(annoCounters())) lines.push(`- ${k}: ${v}`);
    lines.push("## 滚动计数器");
    for (const [k, v] of Object.entries(scrollCounters())) lines.push(`- ${k}: ${v}`);
    const ghost = scrollWatchStats().lastGhost;
    if (ghost) {
      lines.push(`## 最近 ghost 滚动`);
      lines.push(
        `- ${new Date(ghost.ts).toISOString()} ${ghost.msg} ${JSON.stringify(ghost.data ?? {})}`
      );
    }
    if (health) {
      lines.push(`## 批注体检（${new Date(healthAt ?? 0).toISOString()}）`);
      for (const r of health) {
        lines.push(
          `- ${r.id} | 文本:${r.defInMd ? "✓" : "✗"} 节点:${VERDICT_LABEL[r.defInDoc]} 徽章:${VERDICT_LABEL[r.markerInDom]} 编号:${VERDICT_LABEL[r.numStamped]} standalone解析:${VERDICT_LABEL[r.standaloneParse]} 往返:${VERDICT_LABEL[r.roundTrip]} | ${r.shape}${r.notes.length ? " | " + r.notes.join("；") : ""}`
        );
      }
    }
    lines.push("## 最近事件（批注+滚动合并，新在上）");
    const merged = [
      ...annoEvents().map((e) => ({ ...e, src: "anno" })),
      ...scrollEvents().map((e) => ({ ...e, src: "scroll" })),
    ]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100);
    for (const e of merged) {
      lines.push(`- ${fmtTime(e.ts)} [${e.src}/${e.level}] ${e.kind}: ${e.msg}`);
    }
    void navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
  }, [health, healthAt]);

  const counters = annoCounters();
  const scrollCnts = scrollCounters();
  const counterEntries = [
    ...Object.entries(counters),
    ...Object.entries(scrollCnts),
  ];
  const ghost = scrollWatchStats().lastGhost;
  const events = [
    ...annoEvents().map((e) => ({ ...e, src: "批注" })),
    ...scrollEvents().map((e) => ({ ...e, src: "滚动" })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 60);

  return (
    <div className="anno-diag" role="dialog" aria-label="批注与滚动诊断面板">
      <div className="anno-diag-head">
        <span className="anno-diag-title">诊断（批注 + 滚动）</span>
        <div className="anno-diag-actions">
          <button className="anno-btn" onClick={runHealth} title="对当前文档逐条核查（真实解析器）">
            体检
          </button>
          <button className="anno-btn" onClick={copyReport} title="复制完整诊断报告（含滚动证据）">
            复制
          </button>
          <button className="anno-btn" onClick={clearAll} title="清空批注与滚动事件、计数器">
            清空
          </button>
          <button className="anno-btn" onClick={onClose} title="关闭（Ctrl+Alt+D）">
            关闭
          </button>
        </div>
      </div>
      <div className="anno-diag-body">
        {ghost && (
          <>
            <div className="anno-diag-section">最近 ghost 滚动（页面自己动）</div>
            <div className={`anno-diag-event ${ghost.level}`}>
              <span className="t">{fmtTime(ghost.ts)}</span>
              <span className="k">{ghost.kind}</span>
              <span className="m">
                {ghost.msg}
                {ghost.data?.lastWrite ? ` · 前次写入: ${ghost.data.lastWrite}` : " · 无已知写入"}
              </span>
            </div>
          </>
        )}
        <div className="anno-diag-section">计数器</div>
        {counterEntries.length === 0 ? (
          <div className="anno-diag-empty">暂无（打开文档操作一次即有数据）</div>
        ) : (
          <div className="anno-diag-counters">
            {counterEntries.map(([k, v]) => (
              <span key={k} className="anno-diag-counter">
                <b>{v}</b> {k}
              </span>
            ))}
          </div>
        )}
        {health && (
          <>
            <div className="anno-diag-section">
              批注体检{healthAt ? ` · ${fmtTime(healthAt)}` : ""}
            </div>
            {health.length === 0 ? (
              <div className="anno-diag-empty">当前文档没有批注</div>
            ) : (
              <table className="anno-diag-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>节点</th>
                    <th>徽章</th>
                    <th>编号</th>
                    <th>standalone</th>
                    <th>往返</th>
                    <th>形态</th>
                  </tr>
                </thead>
                <tbody>
                  {health.map((r) => (
                    <tr key={r.id} className={r.notes.length ? "bad" : ""}>
                      <td>{r.id}</td>
                      <td>{VERDICT_LABEL[r.defInDoc]}</td>
                      <td>{VERDICT_LABEL[r.markerInDom]}</td>
                      <td>{VERDICT_LABEL[r.numStamped]}</td>
                      <td>{VERDICT_LABEL[r.standaloneParse]}</td>
                      <td>{VERDICT_LABEL[r.roundTrip]}</td>
                      <td title={r.notes.join("；")}>{r.shape}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        <div className="anno-diag-section">事件流（批注+滚动合并，最近 {events.length} 条，新在上）</div>
        <div className="anno-diag-events">
          {events.length === 0 && <div className="anno-diag-empty">暂无事件</div>}
          {events.map((e, i) => (
            <div key={`${e.ts}-${i}`} className={`anno-diag-event ${e.level}`}>
              <span className="t">{fmtTime(e.ts)}</span>
              <span className="k">[{e.src}] {e.kind}</span>
              <span className="m">{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
