// FileManager.ets —— fs.* / app.trashFile / app.appendLog 的桥实现
// （鸿蒙迁移 v4.11）。
//
// 统一经 UriMapper 把前端虚拟路径解析为 file:// URI 或沙箱路径，再走
// @ohos.file.fs。URI 的支持面：open 系（API 12+）明确支持；listFile/
// rename/mkdir 等在 PC（2in1）+ persistPermission 授权下可用（真机验证
// 项，见 harmony/README.md 已知限制）。错误统一抛 BridgeError：
//   E_PERMISSION —— URI 权限过期/未授权（前端引导重选工作区）
//   E_IO —— 其它文件系统错误（带底层码）
//   E_ARGS —— 虚拟路径无法解析

import fs from '@ohos.file.fs';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { BridgeError } from '../bridge/Bridge';
import { ResolvedPath, UriMapper } from './UriMapper';

/** 桥协议：readDir 条目。 */
export interface DirEntryOut {
  name: string;
  isDirectory: boolean;
}

/** 桥协议：stat 结果（mtimeMs 为 epoch 毫秒，前端组装成 Date）。 */
export interface StatOut {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number | null;
}

const PERMISSION_CODES: number[] = [13900001, 13900006];

export class FileManager {
  private readonly mapper: UriMapper;

  constructor(mapper: UriMapper) {
    this.mapper = mapper;
  }

  mapperRef(): UriMapper {
    return this.mapper;
  }

  async readTextFile(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const bytes = await this.readBytes(path);
    return this.decodeUtf8(bytes);
  }

  async readFile(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const bytes = await this.readBytes(path);
    const b64 = new util.Base64Helper().encodeToStringSync(bytes);
    const out: Record<string, Object> = { 'base64': b64 };
    return out;
  }

  async writeTextFile(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const content = this.stringOf(params, 'content');
    const r = this.mapper.resolve(path);
    if (r.kind === 'sandbox') {
      this.ensureSandboxDir(this.parentOf(r.sandboxPath));
    }
    await this.withWriteHandle(r, (fd: number) => {
      return fs.writeSync(fd, content);
    });
    return null;
  }

  async writeFile(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const b64 = this.stringOf(params, 'base64');
    const bytes = new util.Base64Helper().decodeSync(b64);
    const r = this.mapper.resolve(path);
    if (r.kind === 'sandbox') {
      this.ensureSandboxDir(this.parentOf(r.sandboxPath));
    }
    await this.withWriteHandle(r, (fd: number) => {
      return fs.writeSync(fd, bytes.buffer);
    });
    return null;
  }

  async readDir(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const r = this.mapper.resolve(path);
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    let names: string[] = [];
    try {
      // listFile 返回的条目以 '/' 开头（文档行为），统一剥掉取名字段。
      const raw = fs.listFileSync(target);
      const trimmed: string[] = [];
      raw.forEach((n: string) => {
        trimmed.push(n.startsWith('/') ? n.slice(1) : n);
      });
      names = trimmed;
    } catch (err) {
      throw this.wrapFsError(err, `列目录失败 ${path}`);
    }
    const out: DirEntryOut[] = [];
    names.sort((a: string, b: string) => a.localeCompare(b));
    for (const name of names) {
      if (name.length === 0) {
        continue;
      }
      const childPath = `${path}/${name}`;
      let isDir = false;
      try {
        const st = await this.statOf(childPath);
        isDir = st.isDirectory;
      } catch {
        // 个别条目 stat 失败（权限边界）：按文件展示，不拖垮整棵树。
      }
      const e: DirEntryOut = { name: name, isDirectory: isDir };
      out.push(e);
    }
    return out;
  }

  async mkdir(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const r = this.mapper.resolve(path);
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    try {
      if (r.kind === 'sandbox') {
        this.ensureSandboxDir(target);
        return null;
      }
      fs.mkdirSync(target, true);
      return null;
    } catch (err) {
      const e = err as BusinessError;
      if (this.stringOfErr(err).includes('exist')) {
        return null; // mkdir -p 语义：已存在即成功
      }
      throw this.wrapFsError(err, `建目录失败 ${path}`);
    }
  }

  async exists(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    try {
      await this.statOf(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(params: Record<string, Object>): Promise<Object | null> {
    return this.statOf(this.pathOf(params));
  }

  async rename(params: Record<string, Object>): Promise<Object | null> {
    const oldPath = this.stringOf(params, 'oldPath');
    const newPath = this.stringOf(params, 'newPath');
    const a = this.mapper.resolve(oldPath);
    const b = this.mapper.resolve(newPath);
    const from = a.kind === 'sandbox' ? a.sandboxPath : a.uri;
    const to = b.kind === 'sandbox' ? b.sandboxPath : b.uri;
    try {
      fs.renameSync(from, to);
      return null;
    } catch (err) {
      throw this.wrapFsError(err, `重命名失败 ${oldPath} → ${newPath}`);
    }
  }

  /** 永久删除（鸿蒙无公共回收站 API；前端确认弹窗已注明不可恢复）。 */
  async remove(params: Record<string, Object>): Promise<Object | null> {
    return this.permanentlyRemove(this.pathOf(params));
  }

  /** app.trashFile：与 remove 同实现（语义差异由 capabilities.trash=false
   *  在前端文案层表达）。破坏性操作仍经 lib/fileOps 审计层（前端侧）。 */
  async trashFile(params: Record<string, Object>): Promise<Object | null> {
    return this.permanentlyRemove(this.pathOf(params));
  }

  private async permanentlyRemove(path: string): Promise<Object | null> {
    const r = this.mapper.resolve(path);
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    let st: StatOut;
    try {
      st = await this.statOf(path);
    } catch (err) {
      throw this.wrapFsError(err, `删除失败（目标不存在） ${path}`);
    }
    try {
      if (st.isDirectory) {
        fs.rmdirSync(target);
      } else {
        fs.unlinkSync(target);
      }
      return null;
    } catch (err) {
      throw this.wrapFsError(err, `删除失败 ${path}`);
    }
  }

  /** app.appendLog：追加一行；超出 maxBytes 滚动（保留一个 .1 备份，
   *  对齐桌面版 Rust append_log 的轮转语义）。 */
  async appendLog(params: Record<string, Object>): Promise<Object | null> {
    const path = this.stringOf(params, 'path');
    const line = this.stringOf(params, 'line');
    const maxBytes = this.numberOrOf(params, 'maxBytes', 2 * 1024 * 1024);
    const r = this.mapper.resolve(path);
    if (r.kind === 'sandbox') {
      this.ensureSandboxDir(this.parentOf(r.sandboxPath));
    }
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    try {
      const st = fs.statSync(target);
      if (st.size + line.length > maxBytes) {
        try {
          fs.renameSync(target, `${target}.1`);
        } catch {
          // 无备份可滚动 — 直接截断重建
        }
      }
    } catch {
      // 文件不存在 — 首次写入
    }
    const file = fs.openSync(target,
      fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
    try {
      fs.writeSync(file.fd, line);
    } finally {
      fs.closeSync(file);
    }
    return null;
  }

  // ---- 内部工具 ------------------------------------------------------------

  private async statOf(path: string): Promise<StatOut> {
    const r = this.mapper.resolve(path);
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    try {
      const file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      try {
        const st = fs.statSync(file.fd);
        const out: StatOut = {
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          size: st.size,
          // fs.Stat.mtime 即 epoch 毫秒（number），与桥协议 mtimeMs 对齐。
          mtimeMs: st.mtime,
        };
        return out;
      } finally {
        fs.closeSync(file);
      }
    } catch (err) {
      throw this.wrapFsError(err, `stat 失败 ${path}`);
    }
  }

  private async readBytes(path: string): Promise<Uint8Array> {
    const r = this.mapper.resolve(path);
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    try {
      const file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      try {
        const st = fs.statSync(file.fd);
        const buf = new ArrayBuffer(st.size);
        let readTotal = 0;
        while (readTotal < st.size) {
          const n = fs.readSync(file.fd, buf, { offset: readTotal });
          if (n <= 0) {
            break;
          }
          readTotal += n;
        }
        return new Uint8Array(buf.slice(0, readTotal));
      } finally {
        fs.closeSync(file);
      }
    } catch (err) {
      throw this.wrapFsError(err, `读取失败 ${path}`);
    }
  }

  private async withWriteHandle(r: ResolvedPath, write: (fd: number) => number): Promise<void> {
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    let file: fs.File | null = null;
    try {
      file = fs.openSync(target,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      write(file.fd);
    } catch (err) {
      throw this.wrapFsError(err, `写入失败 ${target}`);
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
  }

  private ensureSandboxDir(dir: string): void {
    try {
      fs.mkdirSync(dir, true);
    } catch {
      // 已存在或祖先已建 — 忽略
    }
  }

  private parentOf(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx <= 0 ? '' : p.slice(0, idx);
  }

  private decodeUtf8(bytes: Uint8Array): string {
    const decoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(bytes);
  }

  private pathOf(params: Record<string, Object>): string {
    return this.stringOf(params, 'path');
  }

  private stringOf(params: Record<string, Object>, key: string): string {
    const v = params[key];
    if (typeof v === 'string') {
      return v;
    }
    throw new BridgeError('E_ARGS', `参数缺失或类型错误：${key}`);
  }

  private numberOrOf(params: Record<string, Object>, key: string, dft: number): number {
    const v = params[key];
    if (typeof v === 'number') {
      return v;
    }
    return dft;
  }

  private stringOfErr(err: Object): string {
    return String(err);
  }

  /** fs 错误 → BridgeError：权限码归一 E_PERMISSION（前端引导重选工作区）。 */
  private wrapFsError(err: Object, what: string): BridgeError {
    const e = err as BusinessError;
    const code = typeof e.code === 'number' ? e.code : -1;
    if (PERMISSION_CODES.includes(code) || this.stringOfErr(err).includes('permitted')) {
      return new BridgeError('E_PERMISSION',
        `${what}：无权访问（工作区授权可能已过期，请重新选择目录）`);
    }
    return new BridgeError('E_IO', `${what}：${e.message ?? String(err)}`);
  }
}
