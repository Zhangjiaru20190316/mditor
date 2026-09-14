// WatchManager.ets —— fs.watch / fs.unwatch 桥实现（v4.13 P4：stat 轮询）。
//
// 鸿蒙无公共文件监听 API（inotify 类不开放）→ 快照对比轮询。
// 正确性优先：外部编辑已有文件只改文件自身 mtime（任何父目录 mtime 都
// 不变），「目录 mtime 预筛」会漏掉「外部编辑当前文档」这一主场景——因此
// 每轮全量 stat 对比（快照 diff），成本用上限与间隔控制：
//   * 快照 = Map<虚拟路径, {isDir, mtimeMs, size}>（首轮建基线不发事件）
//   * diff：新增→create；消失→delete；文件 mtime/size 变→modify
//     （目录 mtime 变化不单独发——子项增删已被 diff 覆盖）
//   * 事件一批一轮（轮询间隔 ≥2s，天然合并）：
//     fs-watch-event {watchId, events: FsWatchEvent[]}，FsWatchEvent =
//     {type:{kind}, paths:[虚拟路径]}。kind 用字符串（'create'/'modify'，
//     删除发 'any'——对齐桌面 plugin-fs 对象型 kind 在消费方退化为 'any'
//     的实际语义；vaultIndex 的过滤表不认 'delete' 字符串）
//   * 单轮深扫条目上限 5000：超出记日志并丢弃本轮快照（不崩、不误发）
//   * 间隔：非递归 2s / 递归 5s；同路径同 recursive 重复 watch 引用计数去重
//   * 页面重载（桥端口重建）：全部 watcher 清理，前端冷启动后重挂
//
// 消费方（点亮后自动生效）：useFileWatcher（打开文档父目录，非递归）与
// vaultIndex（工作区根，递归）——均按 watchId 过滤事件。

import { hilog } from '@kit.PerformanceAnalysisKit';
import { Bridge, BridgeError } from '../bridge/Bridge';
import { FileManager, StatOut } from './FileManager';

const DOMAIN = 0x0D01;

/** 单轮深扫条目上限（防失控；超出丢弃本轮快照）。 */
const MAX_ENTRIES = 5000;
/** 轮询间隔：非递归（文档父目录）。 */
const POLL_MS_SHALLOW = 2000;
/** 轮询间隔：递归（工作区根全树）。 */
const POLL_MS_RECURSIVE = 5000;

/** 快照节点。 */
class SnapNode {
  isDir: boolean = false;
  mtimeMs: number = 0;
  size: number = 0;
}

/** 单个 watcher 的全部状态。 */
class WatchEntry {
  id: number = 0;
  path: string = '';
  recursive: boolean = false;
  refCount: number = 1;
  timer: number = -1;
  /** 首轮建基线后置 true；之前不发事件。 */
  based: boolean = false;
  snapshot: Map<string, SnapNode> = new Map();
}

/** 单个文件系统事件（FsWatchEvent 形状，camelCase 无关——type/paths 两键）。 */
interface WatchEventOut {
  type: Record<string, Object>;
  paths: string[];
}

export class WatchManager {
  private readonly bridge: Bridge;
  private readonly fm: FileManager;
  private nextId: number = 1;
  private readonly watchers: Map<number, WatchEntry> = new Map();
  /** `${path}|${recursive}` → watchId（同路径去重，引用计数）。 */
  private readonly byPath: Map<string, number> = new Map();

  constructor(bridge: Bridge, fm: FileManager) {
    this.bridge = bridge;
    this.fm = fm;
  }

  registerAll(): void {
    this.bridge.register('fs.watch', (p) => this.watch(p));
    this.bridge.register('fs.unwatch', (p) => this.unwatch(p));
    hilog.info(DOMAIN, 'mditor', 'WatchManager: fs.watch/fs.unwatch 已注册');
  }

  /** 页面重载：消费方随页面销毁，全部 watcher 拆除（前端冷启动重挂）。 */
  onReload(): void {
    const ids: number[] = [];
    this.watchers.forEach((v: WatchEntry, k: number) => {
      ids.push(k);
    });
    for (const id of ids) {
      this.stopWatcher(id);
    }
    this.byPath.clear();
  }

  // ---- 桥方法 -----------------------------------------------------------------

  async watch(params: Record<string, Object>): Promise<Object | null> {
    const path = this.stringOf(params, 'path');
    const recursive = params['recursive'] === true;
    const key = `${path}|${recursive}`;
    const existing = this.byPath.get(key);
    if (existing !== undefined) {
      const entry = this.watchers.get(existing);
      if (entry !== undefined) {
        entry.refCount += 1;
        const out: Record<string, Object> = { 'watchId': existing };
        return out;
      }
    }
    const entry = new WatchEntry();
    entry.id = this.nextId;
    this.nextId += 1;
    entry.path = path;
    entry.recursive = recursive;
    this.watchers.set(entry.id, entry);
    this.byPath.set(key, entry.id);
    this.schedule(entry);
    const out: Record<string, Object> = { 'watchId': entry.id };
    return out;
  }

  async unwatch(params: Record<string, Object>): Promise<Object | null> {
    const id = params['watchId'];
    if (typeof id !== 'number') {
      throw new BridgeError('E_ARGS', '参数缺失或类型错误：watchId');
    }
    const entry = this.watchers.get(id as number);
    if (entry === undefined) {
      return null; // 幂等
    }
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.stopWatcher(id as number);
      this.byPath.delete(`${entry.path}|${entry.recursive}`);
    }
    return null;
  }

  // ---- 轮询 -------------------------------------------------------------------

  private schedule(entry: WatchEntry): void {
    if (!this.watchers.has(entry.id)) {
      return;
    }
    const delay = entry.recursive ? POLL_MS_RECURSIVE : POLL_MS_SHALLOW;
    entry.timer = setTimeout(() => {
      this.tick(entry);
    }, delay);
  }

  private tick(entry: WatchEntry): void {
    entry.timer = -1;
    if (!this.watchers.has(entry.id)) {
      return;
    }
    this.poll(entry)
      .catch((err: Object) => {
        // 根目录读取失败（权限/已删除）：跳过本轮，不发事件（避免瞬态
        // 错误触发误删索引；根真被删时前端会重挂 watcher）。
        hilog.debug(DOMAIN, 'mditor', 'Watch: 轮询跳过 %{public}s: %{public}s',
          entry.path, String(err).slice(0, 120));
      })
      .then(() => {
        this.schedule(entry);
      });
  }

  private async poll(entry: WatchEntry): Promise<void> {
    const snap = await this.buildSnapshot(entry);
    if (snap === null) {
      return; // 超限：丢弃本轮（保留旧快照，下轮再试）
    }
    if (entry.based) {
      const events = WatchManager.diff(entry.snapshot, snap);
      if (events.length > 0) {
        const payload: Record<string, Object> = {
          'watchId': entry.id,
          'events': events,
        };
        this.bridge.sendEvent('fs-watch-event', payload);
      }
    }
    entry.snapshot = snap;
    entry.based = true;
  }

  /** 全量快照；超限/读失败返回 null（调用方跳过本轮）。 */
  private async buildSnapshot(entry: WatchEntry): Promise<Map<string, SnapNode> | null> {
    const out: Map<string, SnapNode> = new Map();
    const stack: string[] = [entry.path];
    let count = 0;
    while (stack.length > 0) {
      const dir = stack[stack.length - 1];
      stack.pop();
      const names = await this.fm.listEntryNames(dir);
      for (const name of names) {
        if (name.length === 0) {
          continue;
        }
        const child = `${dir}/${name}`;
        let st: StatOut;
        try {
          st = await this.fm.statByPath(child);
        } catch {
          continue; // 权限边界条目：跳过（不拖垮整轮）
        }
        count += 1;
        if (count > MAX_ENTRIES) {
          hilog.warn(DOMAIN, 'mditor',
            'Watch: 单轮条目超上限 %{public}d，丢弃本轮快照 %{public}s', MAX_ENTRIES, entry.path);
          return null;
        }
        const node = new SnapNode();
        node.isDir = st.isDirectory;
        node.mtimeMs = st.mtimeMs ?? 0;
        node.size = st.size;
        out.set(child, node);
        if (entry.recursive && st.isDirectory) {
          stack.push(child);
        }
      }
    }
    return out;
  }

  /** 快照 diff → 事件列表（create/delete/modify；delete 以 'any' 表达）。 */
  static diff(oldSnap: Map<string, SnapNode>, newSnap: Map<string, SnapNode>): WatchEventOut[] {
    const out: WatchEventOut[] = [];
    newSnap.forEach((node: SnapNode, path: string) => {
      const prev = oldSnap.get(path);
      if (prev === undefined) {
        out.push(WatchManager.eventOf('create', path));
        return;
      }
      if (!node.isDir && (node.mtimeMs !== prev.mtimeMs || node.size !== prev.size)) {
        out.push(WatchManager.eventOf('modify', path));
      }
    });
    oldSnap.forEach((node: SnapNode, path: string) => {
      if (!newSnap.has(path)) {
        out.push(WatchManager.eventOf('any', path));
      }
    });
    return out;
  }

  private static eventOf(kind: string, path: string): WatchEventOut {
    const t: Record<string, Object> = { 'kind': kind };
    const paths: string[] = [path];
    return { type: t, paths: paths };
  }

  // ---- 内部 -------------------------------------------------------------------

  private stopWatcher(id: number): void {
    const entry = this.watchers.get(id);
    if (entry !== undefined && entry.timer >= 0) {
      clearTimeout(entry.timer);
    }
    this.watchers.delete(id);
  }

  private stringOf(params: Record<string, Object>, key: string): string {
    const v = params[key];
    if (typeof v === 'string') {
      return v;
    }
    throw new BridgeError('E_ARGS', `参数缺失或类型错误：${key}`);
  }
}
