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
