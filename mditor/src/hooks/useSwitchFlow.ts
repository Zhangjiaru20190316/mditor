// 文件/标签切换动画状态机（V3.6.5 从 App.tsx 抽出）。
//
// 职责边界（对 App 只暴露最小面）：
//   * beginSwitch —— 切换统一入口：作废更早的切换（token 递增 + 取消旧收尾
//     定时器 + 取消挂起的空闲预解析），立即置起 loading bar / 大文档遮罩；
//   * updateSwitchHeavy —— 中途更正大文档判定（内容读到一半才知道大不大）；
//   * finishSwitch —— 统一收尾：保证动画至少可见 MIN_SWITCH_MS，且只有最新
//     token 有权收尾；收尾后的 idle 窗口安排一次空闲预解析（阶段 1）。
//
// token 语义：rapid second click（A → B before A finishes）时 A 的迟到结果
// 不得覆盖 B —— 只有 switchTokenRef.current 的最新值有权改编辑器与收尾 UI。
// 纯时序判定（最短可见剩余时长 / 是否需要等帧）在 lib/switchTiming.ts 单测。

import { useCallback, useRef, useState } from "react";
import {
  MIN_SWITCH_MS,
  needsPaintYield,
  remainingSwitchDelay,
} from "../lib/switchTiming";
import { cancelIdlePreparse, scheduleIdlePreparse } from "../lib/parsePipeline";

export interface SwitchFlow {
  pendingPath: string | null;
  docSwitching: boolean;
  switchHeavy: boolean;
  docSwitchingRef: React.MutableRefObject<boolean>;
  switchHeavyRef: React.MutableRefObject<boolean>;
  switchTokenRef: React.MutableRefObject<number>;
  /** 切换统一入口（见上文）；返回本次切换的 token。 */
  beginSwitch: (path: string | null, heavy: boolean) => number;
  /** 中途更正大文档判定（openPath 委托 activateTab 前先亮遮罩）。 */
  updateSwitchHeavy: (heavy: boolean) => void;
  /** 统一收尾：MIN_SWITCH_MS 最短可见 + 仅最新 token 有权收尾。 */
  finishSwitch: (token: number, startedAt: number) => void;
  /** token 是否已被更新的切换作废（App 各 await 点的过期检查都走它）。 */
  isStale: (token: number) => boolean;
  /** needsPaintYield 的绑定版（读 flow 自己的 ref；供 activateTab 等帧判定）。 */
  shouldYieldPaint: (heavy: boolean) => boolean;
  /** 切换收尾后的空闲预解析安排（目标由 getTarget 决定，预算 1 个）。 */
  scheduleFollowUpPreparse: (getTarget: () => string | null) => void;
}

/** 等两帧：确保切换动画（loading bar / 大文档遮罩）已提交到屏幕，再进入
 *  会长时间阻塞主线程的重活（整篇 replaceAll 重解析）。没有这个 yield，
 *  点击与重活落进同一个被阻塞的帧里，动画要等解析完才第一次绘制。 */
export function nextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function useSwitchFlow(): SwitchFlow {
  // pendingPath: optimistically highlighted in the file tree the instant a row
  //   is clicked — before the file is even read. Gives immediate visual
  //   acknowledgement (<1 frame) the way iOS list taps do.
  // docSwitching: drives the top loading bar while the new document is being
  //   read and rendered into the editor.
  // switchHeavy: 大文档（isBigDoc）切换时在编辑区叠加遮罩 + shimmer 动效，
  //   掩盖整篇重解析的长时间主线程阻塞；小文档只保留 2px 顶栏、内容即刻
  //   可见，不被最短可见时长拖慢。
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [docSwitching, setDocSwitching] = useState(false);
  const [switchHeavy, setSwitchHeavy] = useState(false);
  const docSwitchingRef = useRef(false);
  const switchHeavyRef = useRef(false);
  // Token guard so a rapid second click (A → B before A finishes loading)
  // doesn't let A's late result overwrite B. Only the newest click's load is
  // committed to the editor; superseded loads bail out silently.
  const switchTokenRef = useRef(0);
  // Tracks the deferred clear of the switching UI (see finishSwitch). Held in
  // a ref so a newer click can cancel a still-pending min-duration timer on
  // entry, preventing stale timers from stacking / clearing state at the
  // wrong time.
  const switchClearTimerRef = useRef<number | undefined>(undefined);

  const beginSwitch = useCallback((path: string | null, heavy: boolean): number => {
    const token = ++switchTokenRef.current;
    if (switchClearTimerRef.current != null) {
      window.clearTimeout(switchClearTimerRef.current);
      switchClearTimerRef.current = undefined;
    }
    // 新切换优先：取消还挂在 idle 队列里的预解析，避免与真实加载争抢 worker。
    cancelIdlePreparse();
    docSwitchingRef.current = true;
    switchHeavyRef.current = heavy;
    setSwitchHeavy(heavy);
    setPendingPath(path);
    setDocSwitching(true);
    return token;
  }, []);

  const updateSwitchHeavy = useCallback((heavy: boolean) => {
    if (switchHeavyRef.current === heavy) return;
    switchHeavyRef.current = heavy;
    setSwitchHeavy(heavy);
  }, []);

  const finishSwitch = useCallback((token: number, startedAt: number) => {
    const clear = () => {
      if (token !== switchTokenRef.current) return;
      docSwitchingRef.current = false;
      switchHeavyRef.current = false;
      setSwitchHeavy(false);
      setPendingPath(null);
      setDocSwitching(false);
      switchClearTimerRef.current = undefined;
    };
    const remaining = remainingSwitchDelay(startedAt, performance.now(), MIN_SWITCH_MS);
    if (remaining <= 0) clear();
    else switchClearTimerRef.current = window.setTimeout(clear, remaining);
  }, []);

  const shouldYieldPaint = useCallback((heavy: boolean) => {
    return needsPaintYield(docSwitchingRef.current, switchHeavyRef.current, heavy);
  }, []);

  const isStale = useCallback(
    (token: number) => token !== switchTokenRef.current,
    []
  );

  const scheduleFollowUpPreparse = useCallback((getTarget: () => string | null) => {
    scheduleIdlePreparse(getTarget);
  }, []);

  return {
    pendingPath,
    docSwitching,
    switchHeavy,
    docSwitchingRef,
    switchHeavyRef,
    switchTokenRef,
    beginSwitch,
    updateSwitchHeavy,
    finishSwitch,
    isStale,
    shouldYieldPaint,
    scheduleFollowUpPreparse,
  };
}
