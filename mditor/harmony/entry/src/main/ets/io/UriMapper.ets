// UriMapper.ets —— 虚拟路径 ↔ 用户文件 URI 的映射核心（鸿蒙迁移 v4.11）。
//
// 背景：鸿蒙沙箱无任意路径访问；用户经 DocumentViewPicker 选定的工作区
// 返回 file://docs/… URI。而前端全部业务以「路径字符串」为语义（与
// Windows 版共享代码）。方案（设计书 5.5）：
//
//   /Docs/<token>/<相对路径>   工作区根（或单文件挂载的父目录）
//   /AppData/<相对路径>        应用沙箱 filesDir（日志/暂存/设置）
//
// token 稳定分配（ws-1、ws-2…）并持久化到 filesDir/uri-map.json（UTF-8
// 无 BOM），重启后还原；还原失败（URI 权限过期）不崩溃——访问时才报
// E_PERMISSION，前端引导用户重新选择（对齐桌面版对失效最近文件的容错）。
//
// 纯逻辑类：filesDir 经构造注入，hypium 本地单测覆盖（UriMapper.test.ets）。

import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';

/** 单个工作区挂载条目。 */
export interface UriEntry {
  token: string;
  rootUri: string;
  /** 展示名（选择时的目录/文件名）。 */
  displayName: string;
}

/** uri-map.json 的落盘结构。 */
interface UriMapFile {
  version: number;
  nextId: number;
  entries: UriEntry[];
}

/** 路径解析结果：要么映射到 URI，要么映射到沙箱真实路径。 */
export interface ResolvedPath {
  kind: string; // 'uri' | 'sandbox'
  /** kind=uri 时有效：文件/目录的完整 file:// URI。 */
  uri: string;
  /** kind=sandbox 时有效：沙箱内绝对路径。 */
  sandboxPath: string;
}

const MAP_VERSION = 1;

export class UriMapper {
  private readonly mapFile: string;
  private entries: Map<string, UriEntry> = new Map();
  private nextId = 1;

  constructor(filesDir: string) {
    this.mapFile = `${filesDir}/uri-map.json`;
    this.load();
  }

  /** 启动时重新激活已持久化 URI 的访问权限（Picker 授权重启后失效）。 */
  reactivate(activate: (uri: string) => void): void {
    this.entries.forEach((entry: UriEntry) => {
      activate(entry.rootUri);
    });
  }

  /** 挂载一个工作区根，返回其虚拟根路径（/Docs/<token>）。幂等：同一
   *  rootUri 重复挂载复用已有 token（重开同一工作区不膨胀）。 */
  mountRoot(rootUri: string, displayName: string): string {
    const existing = this.findByUri(rootUri);
    if (existing !== null) {
      return `/Docs/${existing.token}`;
    }
    const token = `ws-${this.nextId}`;
    this.nextId += 1;
    const entry: UriEntry = { token: token, rootUri: rootUri, displayName: displayName };
    this.entries.set(token, entry);
    this.persist();
    return `/Docs/${token}`;
  }

  /** 虚拟路径 → 真实位置。无法解析抛 Error（E_ARGS 语义）。 */
  resolve(virtualPath: string): ResolvedPath {
    if (typeof virtualPath !== 'string' || virtualPath.length === 0) {
      throw new Error(`非法路径：${virtualPath}`);
    }
    if (virtualPath === '/AppData' || virtualPath.startsWith('/AppData/')) {
      const sandbox = this.sandboxBase();
      const rel = virtualPath === '/AppData' ? '' : virtualPath.slice('/AppData'.length);
      const result: ResolvedPath = {
        kind: 'sandbox',
        uri: '',
        sandboxPath: `${sandbox}${rel}`,
      };
      return result;
    }
    if (virtualPath.startsWith('/Docs/')) {
      const rest = virtualPath.slice('/Docs/'.length);
      const slash = rest.indexOf('/');
      const token = slash < 0 ? rest : rest.slice(0, slash);
      const rel = slash < 0 ? '' : rest.slice(slash + 1);
      const entry = this.entries.get(token);
      if (entry === undefined) {
        throw new Error(`未知的工作区 token：${token}（可能已被重置）`);
      }
      const uri = rel.length === 0
        ? entry.rootUri
        : `${entry.rootUri}/${rel.split('/').map((s: string) => encodeURIComponent(s)).join('/')}`;
      const result: ResolvedPath = { kind: 'uri', uri: uri, sandboxPath: '' };
      return result;
    }
    throw new Error(`无法解析的虚拟路径：${virtualPath}`);
  }

  /** 供 mditor-asset:// 图片供源（Index.onInterceptRequest）使用。 */
  tryResolve(virtualPath: string): ResolvedPath | null {
    try {
      return this.resolve(virtualPath);
    } catch {
      return null;
    }
  }

  /** 当前全部挂载（诊断用）。 */
  listEntries(): UriEntry[] {
    const out: UriEntry[] = [];
    this.entries.forEach((e: UriEntry) => {
      out.push(e);
    });
    return out;
  }

  private findByUri(rootUri: string): UriEntry | null {
    let found: UriEntry | null = null;
    this.entries.forEach((e: UriEntry) => {
      if (e.rootUri === rootUri) {
        found = e;
      }
    });
    return found;
  }

  private sandboxBase(): string {
    // mapFile 形如 <filesDir>/uri-map.json —— filesDir 即去掉最后一段。
    const idx = this.mapFile.lastIndexOf('/');
    return this.mapFile.slice(0, idx);
  }

  private load(): void {
    try {
      if (!fs.accessSync(this.mapFile)) {
        return;
      }
      const text = fs.readTextSync(this.mapFile);
      const parsed = JSON.parse(text) as UriMapFile;
      if (parsed === null || !Array.isArray(parsed.entries)) {
        return;
      }
      this.entries = new Map();
      parsed.entries.forEach((e: UriEntry) => {
        this.entries.set(e.token, e);
      });
      this.nextId = typeof parsed.nextId === 'number' ? parsed.nextId : this.entries.size + 1;
    } catch (err) {
      // map 损坏：丢弃映射（用户重选工作区即可），绝不拖垮启动。
      hilog.warn(0x0D01, 'mditor', 'UriMapper: uri-map.json 加载失败（重置）: %{public}s',
        String(err));
      this.entries = new Map();
      this.nextId = 1;
    }
  }

  /** UTF-8 无 BOM 落盘（中文目录名安全）。 */
  private persist(): void {
    const list: UriEntry[] = [];
    this.entries.forEach((e: UriEntry) => {
      list.push(e);
    });
    const data: UriMapFile = { version: MAP_VERSION, nextId: this.nextId, entries: list };
    try {
      const file = fs.openSync(this.mapFile, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE |
        fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, JSON.stringify(data));
      fs.closeSync(file);
    } catch (err) {
      hilog.error(0x0D01, 'mditor', 'UriMapper: 持久化失败: %{public}s', String(err));
    }
  }
}
