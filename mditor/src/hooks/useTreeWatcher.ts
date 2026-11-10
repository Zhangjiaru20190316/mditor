// useTreeWatcher（v5.3.x 外部关联）：工作区根的递归目录监听——文件树自动
// 刷新的事件源（FileTree 此前完全不监听磁盘，靠手动 ↻ 与全局事件刷新）。
//
//   根递归 watch → 事件路径按 externalLink.shouldReactToChange 过滤（断开的
//   文件夹 / 类型不在生效集合不反应）→ 防抖合并 → onBatch(paths)。
//
// 语义与降级：
//   * 无 watch 能力的平台（capabilities.watch 为 false）静默跳过——树回到
//     手动刷新的既有行为；
//   * 监听启动失败（网络盘/权限目录）软降级：sysEmit 诊断，不 crash；
//   * 仅随 rootsKey 重挂；externalLinkOptions 经 ref 读活值，配置变化不重挂
//     （与 vaultIndex 对 excluded 的处理同理——重挂窗口内会丢事件）；
//   * 自身写盘的回声事件由 onBatch 消费方的 sameEntries 无变化守卫消化。

import { useEffect, useRef } from "react";
import { getAdapter } from "../platform";
import { sysEmit } from "../lib/sysDebug";
import { shouldReactToChange } from "../lib/externalLink";
import type { RootLinkOptions } from "../types";

interface Options {
  /** 工作区根目录列表。 */
  roots: string[];
  /** 外部关联配置（键 = 根路径；缺省键 = 全关联全类型）。 */
  externalLinkOptions: Record<string, RootLinkOptions> | undefined;
  /** 防抖批量回调（通过滤网的原始事件路径）。 */
  onBatch: (paths: string[]) => void;
  /** 防抖窗口 ms（缺省 400）。 */
  debounceMs?: number;
}

export function useTreeWatcher({
  roots,
  externalLinkOptions,
  onBatch,
  debounceMs = 400,
}: Options): void {
  // 活值镜像：监听回调读最新配置与回调，roots 仅随 rootsKey 重挂。
  const liveRef = useRef({ externalLinkOptions, onBatch, roots });
  liveRef.current = { externalLinkOptions, onBatch, roots };
  const rootsKey = roots.join("\n");

  useEffect(() => {
    const watchFn = getAdapter().fs.watch;
    if (!watchFn || liveRef.current.roots.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    const unlisteners: Array<() => void> = [];

    const flush = (): void => {
      timer = null;
      if (pending.size === 0) return;
      const batch = [...pending];
      pending.clear();
      liveRef.current.onBatch(batch);
    };
    const schedule = (): void => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    };

    for (const root of liveRef.current.roots) {
      watchFn(
        root,
        (event) => {
          const kind = (event.type as { kind?: string }).kind ?? "any";
          if (kind !== "modify" && kind !== "create" && kind !== "remove" && kind !== "any") {
            return;
          }
          const opts = () => liveRef.current.externalLinkOptions ?? {};
          for (const p of event.paths) {
            if (!shouldReactToChange(p, liveRef.current.roots, opts)) continue;
            pending.add(p);
          }
          if (pending.size > 0) schedule();
        },
        { recursive: true }
      )
        .then((un) => {
          if (cancelled) {
            try {
              un();
            } catch {
              /* gone */
            }
            return;
          }
          unlisteners.push(un);
        })
        .catch((err) => {
          // 网络盘/权限目录监听失败：软失败（与 useFileWatcher / vaultIndex
          // 同策略），文件树照常工作，只是回到手动刷新。
          sysEmit("tree:watch-fail", `文件树监听启动失败 ${root}`, {
            level: "warn",
            data: { root, err: String(err).slice(0, 160) },
          });
        });
    }

    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
      for (const un of unlisteners) {
        try {
          un();
        } catch {
          /* already gone */
        }
      }
    };
    // rootsKey 变化（根列表增删）才重挂；liveRef 保证回调读活值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, debounceMs]);
}
