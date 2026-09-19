// SettingsStore.ets —— store.* 桥实现（鸿蒙迁移 v4.11）。
//
// 沙箱 filesDir/mditor.json，键与格式与桌面版 plugin-store 完全一致
// （settings / recent / workspaces / recentWorkspaces）——两端可互换。
// 内存镜像 + save() 落盘（对齐 LazyStore 语义）；UTF-8 无 BOM。
// 内部用 Map（ArkTS 无 delete 操作符），落盘时序列化为 JSON 对象。

import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BridgeError } from '../bridge/Bridge';

export class SettingsStore {
  private readonly file: string;
  private data: Map<string, Object> = new Map();

  constructor(filesDir: string) {
    this.file = `${filesDir}/mditor.json`;
    this.load();
  }

  get(params: Record<string, Object>): Object | null {
    const key = this.keyOf(params);
    const v = this.data.get(key);
    // 桥协议：缺失键统一 null（前端适配器还原为 undefined）。
    return v === undefined ? null : v;
  }

  set(params: Record<string, Object>): Object | null {
    const key = this.keyOf(params);
    const value = params['value'];
    if (value !== undefined && value !== null) {
      this.data.set(key, value);
    } else {
      this.data.delete(key);
    }
    return null;
  }

  delete(params: Record<string, Object>): Object | null {
    const key = this.keyOf(params);
    this.data.delete(key);
    return null;
  }

  save(params: Record<string, Object>): Promise<Object | null> {
    const out: Record<string, Object> = {};
    this.data.forEach((value: Object, key: string) => {
      out[key] = value;
    });
    // D5：先写 .tmp 再 rename 原子替换（截断式覆写在断电/崩溃中途会留下
    // 半份 JSON → 下次启动静默重置全部设置）。旧文件让位为 .bak 供回退。
    const tmp = `${this.file}.tmp`;
    const bak = `${this.file}.bak`;
    try {
      const file = fs.openSync(tmp,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, JSON.stringify(out));
      } finally {
        fs.closeSync(file);
      }
      try {
        if (fs.accessSync(this.file)) {
          fs.copyFileSync(this.file, bak);
        }
      } catch (ign) {
        // .bak 让位失败不阻塞主写入
      }
      fs.renameSync(tmp, this.file);
      return Promise.resolve(null);
    } catch (err) {
      hilog.error(0x0D01, 'mditor', 'SettingsStore: 落盘失败 %{public}s', String(err));
      const msg = `设置保存失败：${String(err)}`;
      return Promise.reject(new Error(msg));
    }
  }

  /** D5：读取并装载一份设置文件；任何失败返回 false（调用方决定回退）。 */
  private tryLoadFrom(path: string): boolean {
    try {
      if (!fs.accessSync(path)) {
        return false;
      }
      const text = fs.readTextSync(path);
      const parsed = JSON.parse(text) as Record<string, Object>;
      if (parsed !== null && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        keys.forEach((key: string) => {
          const v: Object | undefined = parsed[key];
          if (v !== undefined) {
            this.data.set(key, v);
          }
        });
        return true;
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  private load(): void {
    if (this.tryLoadFrom(this.file)) {
      return;
    }
    // D5：主文件损坏/缺失 → 尝试上次成功写入前的 .bak 快照，最后才重置
    // （断电丢设置的概率从「每次写坏必丢」降到「两次连续损坏才丢」）。
    if (this.data.size === 0 && this.tryLoadFrom(`${this.file}.bak`)) {
      hilog.warn(0x0D01, 'mditor', 'SettingsStore: 主文件损坏，已从 .bak 恢复');
      return;
    }
    hilog.warn(0x0D01, 'mditor', 'SettingsStore: mditor.json 加载失败（重置）');
    this.data = new Map();
  }

  private keyOf(params: Record<string, Object>): string {
    const k = params['key'];
    if (typeof k === 'string') {
      return k;
    }
    // N25：抛 BridgeError(E_ARGS) 而非裸 Error——裸 Error 会被 Bridge.ets
    // 归一成 E_INTERNAL，语义失真（这是调用方参数问题，不是内部错误）。
    // SettingsStore → Bridge 单向依赖，无循环。
    throw new BridgeError('E_ARGS', '参数缺失或类型错误：key');
  }
}
