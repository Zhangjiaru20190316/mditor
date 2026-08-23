// 开发者模式警告弹窗（v4.2）——订阅 lib/devMode 的异常放行流（同代码 60s
// 冷却已在记录器侧完成），右上角浮动警告卡：错误代码 + 标题 + 摘要 +
// 「复制报告 / 诊断面板」按钮，10s 自动消退，同屏至多 5 张。
//
// error 级异常（未捕获异常 / Promise 拒绝 / 日志写入失败）与内存自愈
// （MD-4003）额外触发一次 Tauri 原生 warning 弹窗——每代码每会话最多一次，
// 防止异常风暴时原生弹窗连发打断调试。仅 devMode 开启时由 App 挂载，
// 卸载即零开销。
//
// 纪律同其他诊断组件：所有回调整 try/catch，绝不向编辑器抛错。

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { showAlert } from "../lib/dialogs";
import {
  devModeStats,
  recentAnomalies,
  subscribeDevAlerts,
} from "../lib/devMode";
import type { DevAnomaly } from "../lib/devAnomaly";

interface Props {
  /** 打开诊断面板（写回设置项 annoDiagPanel）。 */
  onOpenDiagnostics: () => void;
}

interface AlertItem {
  key: number;
  anomaly: DevAnomaly;
  /** 弹出时刻该代码的累计出现次数（tracker 快照）。 */
  count: number;
}

const AUTO_DISMISS_MS = 10_000;
const MAX_STACK = 5;
/** 原生弹窗是否额外弹出（error 级或内存自愈）。 */
function nativeDialogWorthy(a: DevAnomaly): boolean {
  return a.level === "error" || a.code === "MD-4003";
}

let seq = 0;

export const DevAlerts = memo(function DevAlerts({ onOpenDiagnostics }: Props) {
  const [items, setItems] = useState<AlertItem[]>([]);
  const nativeShown = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((key: number) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }, []);

  useEffect(() => {
    // Set 实例由 useRef 持有、本组件存续期内不变——effect 内快照到局部，
    // cleanup 读取的就是同一实例（react-hooks/exhaustive-deps 约定）。
    const timerSet = timers.current;
    const push = (a: DevAnomaly) => {
      try {
        const item: AlertItem = {
          key: ++seq,
          anomaly: a,
          count: recentAnomalies().find((t) => t.code === a.code)?.count ?? 1,
        };
        setItems((prev) => [...prev.slice(-(MAX_STACK - 1)), item]);
        const t = setTimeout(() => {
          timerSet.delete(t);
          dismiss(item.key);
        }, AUTO_DISMISS_MS);
        timerSet.add(t);
        if (nativeDialogWorthy(a) && !nativeShown.current.has(a.code)) {
          nativeShown.current.add(a.code);
          void showAlert(
            `【${a.code}】${a.title}\n\n${a.detail}\n\n详细信息见诊断面板（Ctrl+Alt+D）与应用数据目录 logs/ 下的日志。`,
            "Mditor 开发者模式警告",
            "warning"
          ).catch(() => {});
        }
      } catch {
        /* never throw */
      }
    };
    const unsub = subscribeDevAlerts(push);
    return () => {
      unsub();
      for (const t of timerSet) clearTimeout(t);
      timerSet.clear();
    };
  }, [dismiss]);

  const copyReport = useCallback((a: DevAnomaly) => {
    try {
      const s = devModeStats();
      const lines = [
        `# mditor 开发者模式异常报告 @ ${new Date().toISOString()}`,
        `错误代码：${a.code}（${a.level}）`,
        `标题：${a.title}`,
        `详情：${a.detail}`,
        a.data ? `数据：${JSON.stringify(a.data)}` : "",
        "",
        `## 本次会话全部异常（冷却合并口径）`,
        ...recentAnomalies().map(
          (t) =>
            `- ${t.code} ×${t.count} ${t.title}｜最近 ${new Date(t.lastTs).toISOString()}：${t.lastDetail}`
        ),
        "",
        `## 记录器状态`,
        `事件日志：写入 ${s.events?.written ?? 0} 行 / 队列丢弃 ${
          s.events?.dropped ?? 0
        } / 写入失败 ${s.writeFailures}`,
      ].filter(Boolean);
      void navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
    } catch {
      /* never throw */
    }
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="dev-alerts" role="status" aria-label="开发者模式异常警告">
      {items.map((it) => (
        <div key={it.key} className={`dev-alert ${it.anomaly.level}`}>
          <div className="dev-alert-head">
            <span className="dev-alert-code">{it.anomaly.code}</span>
            <span className="dev-alert-title">
              {it.anomaly.title}
              {it.count > 1 ? ` ×${it.count}` : ""}
            </span>
            <button
              className="dev-alert-close"
              onClick={() => dismiss(it.key)}
              title="关闭"
              type="button"
            >
              ×
            </button>
          </div>
          <div className="dev-alert-detail" title={it.anomaly.detail}>
            {it.anomaly.detail}
          </div>
          <div className="dev-alert-actions">
            <button type="button" onClick={() => copyReport(it.anomaly)}>
              复制报告
            </button>
            <button type="button" onClick={onOpenDiagnostics}>
              诊断面板
            </button>
          </div>
        </div>
      ))}
    </div>
  );
});
