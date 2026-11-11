import { useEffect, useState } from "react";

/**
 * 短延时卸载（v4.1 退场动效）：`open` 翻为 false 后保持挂载 `exitMs` 毫秒，
 * 让 CSS 退场动画（.closing 类）播完再真正返回 null。重开时立即恢复挂载并
 * 取消在途定时器——退场不会与新一轮入场叠加。
 *
 * 用法：
 *   const mounted = useDelayedUnmount(open, 240);
 *   if (!mounted) return null;
 *   <div className={`modal-backdrop${!open ? " closing" : ""}`}>…</div>
 *
 * prefers-reduced-motion / 动效「无」档下退场动画被全局 kill switch 压成
 * 瞬时（元素即刻透明且 .closing 已禁指针），延时窗口只是卸载时序，无感。
 */
export function useDelayedUnmount(open: boolean, exitMs: number): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    // open -> false：等退场动画播完再卸载；重开（或卸载）时清掉定时器。
    const t = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);
  return mounted;
}

/**
 * 值快照版退场（v5.3.2 弹层退场）：`value` 变 null 后保住**最后一个非空值**
 * `exitMs` 毫秒——调用方用快照继续渲染弹层并加 `.closing` 类播退场，真正
 * 归 null 才卸载。与 useDelayedUnmount 的区别：这里返回值本身（弹层的
 * 定位/内容快照），调用方 `closing = value === null && ghost !== null`。
 *
 * 用法：
 *   const ghost = useExitGhost(ctxMenu, 140);
 *   {ghost && <ContextMenu {...ghost} closing={ctxMenu === null} … />}
 *
 * 重开竞态：null → 新值时立即换新值（旧快照不叠加）；调用方需保证 value
 * 在打开期间引用稳定（state 对象天然满足）。
 */
export function useExitGhost<T>(value: T | null, exitMs: number): T | null {
  const [ghost, setGhost] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      setGhost(value);
      return;
    }
    const t = window.setTimeout(() => setGhost(null), exitMs);
    return () => window.clearTimeout(t);
  }, [value, exitMs]);
  return ghost;
}
