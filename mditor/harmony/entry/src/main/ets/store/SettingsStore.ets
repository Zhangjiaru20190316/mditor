// SettingsStore.ets —— store.* 桥实现（鸿蒙迁移 v4.11）。
//
// 沙箱 filesDir/mditor.json，键与格式与桌面版 plugin-store 完全一致
// （settings / recent / workspaces / recentWorkspaces）——两端可互换。
// 内存镜像 + save() 落盘（对齐 LazyStore 语义）；UTF-8 无 BOM。
// 内部用 Map（ArkTS 无 delete 操作符），落盘时序列化为 JSON 对象。

import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';

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
    try {
      const file = fs.openSync(this.file,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, JSON.stringify(out));
      } finally {
        fs.closeSync(file);
      }
      return Promise.resolve(null);
    } catch (err) {
      hilog.error(0x0D01, 'mditor', 'SettingsStore: 落盘失败 %{public}s', String(err));
      const msg = `设置保存失败：${String(err)}`;
      return Promise.reject(new Error(msg));
    }
  }

  private load(): void {
    try {
      if (!fs.accessSync(this.file)) {
        return;
      }
      const text = fs.readTextSync(this.file);
      const parsed = JSON.parse(text) as Record<string, Object>;
      if (parsed !== null && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        keys.forEach((key: string) => {
          const v: Object | undefined = parsed[key];
          if (v !== undefined) {
            this.data.set(key, v);
          }
        });
      }
    } catch (err) {
      // 写坏的手改文件：丢弃重开（与前端 loadRecent 的容错一致）。
      hilog.warn(0x0D01, 'mditor', 'SettingsStore: mditor.json 加载失败（重置）: %{public}s',
        String(err));
      this.data = new Map();
    }
  }

  private keyOf(params: Record<string, Object>): string {
    const k = params['key'];
    if (typeof k === 'string') {
      return k;
    }
    throw new Error('参数缺失或类型错误：key');
  }
}
