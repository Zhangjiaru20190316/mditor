// FileManager.ets —— fs.* / app.trashFile / app.appendLog 的桥实现
// （鸿蒙迁移 v4.11）。
//
// 统一经 UriMapper 把前端虚拟路径解析为 file:// URI 或沙箱路径，再走
// @ohos.file.fs。URI 的支持面（MatePad Edge 真机 2026-09-19 实锤）：open 系
// （API 12+）可用；listFile 走 URI 报 ENOENT（file_api errno 2）——必须先
// FileUri.toPath() 转真实路径再列（见 listTargetOf）。错误统一抛 BridgeError：
//   E_PERMISSION —— URI 权限过期/未授权（前端引导重选工作区）
//   E_IO —— 其它文件系统错误（带底层码）
//   E_ARGS —— 虚拟路径无法解析

import fs from '@ohos.file.fs';
import { fileUri } from '@kit.CoreFileKit';
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

  /** listFile 的目标路径：listFile 不支持 file:// URI（真机 errno 2 实锤，
   *  open 系才有 URI 支持面）——file://docs/... 去掉 authority 取 path 段
   *  还原真实路径；百分号编码（中文目录名）防御式解码。 */
  private listTargetOf(r: ResolvedPath): string {
    if (r.kind === 'sandbox') {
      return r.sandboxPath;
    }
    const p = new fileUri.FileUri(r.uri).path;
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  }

  /** 同步远程目录名（v4.13.1 键收敛）：工作区根的真实文件夹名。非 /Docs
   *  根 / 未知 token 返回 null，前端回退 basename。 */
  async syncName(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const name = this.mapper.syncNameOf(path);
    if (name === null) {
      return null;
    }
    const out: Record<string, Object> = { 'name': name };
    return out;
  }

  mapperRef(): UriMapper {
    return this.mapper;
  }

  /** N8：虚拟路径 → 可列目录的真实目标（沙箱路径或 URI 的 FileUri.path 解码
   *  形态）。WatchManager 的 TaskPool 扫描以真实路径遍历（worker 内不经
   *  UriMapper），根目标由主线程解析一次。无法解析抛 Error（E_ARGS 语义）。 */
  realTargetOf(virtualPath: string): string {
    return this.listTargetOf(this.mapper.resolve(virtualPath));
  }

  /** P6：S3 文件通道——虚拟路径直读字节（ArkTS 桥内直传，不经 base64 IPC
   *  往返；同步引擎 s3GetFile/s3PutFile 鸿蒙分支的底层）。 */
  async readFileBytesVirtual(path: string): Promise<Uint8Array> {
    return this.readBytes(path);
  }

  /** P6：S3 文件通道——字节直写虚拟路径（父目录自动创建，沙箱侧对齐
   *  writeFile 的 ensureSandboxDir 行为）。 */
  async writeFileBytesVirtual(path: string, bytes: Uint8Array): Promise<void> {
    const r = this.mapper.resolve(path);
    if (r.kind === 'sandbox') {
      this.ensureSandboxDir(this.parentOf(r.sandboxPath));
    }
    // bytes 可能是视图（byteOffset ≠ 0）：截出精确区间再写，避免写出前缀垃圾。
    const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await this.withWriteHandle(r, (fd: number) => fs.writeSync(fd, exact));
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
    const target = this.listTargetOf(r);
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

  /** 永久删除（鸿蒙无公共回收站 API；前端确认弹窗已注明不可恢复）。
   *  N2：读取 params.recursive（缺省 false，与前端 platform/harmony
   *  传参对齐）——fs.rmdirSync 单参不递归，非空目录直删必抛；目录 +
   *  recursive=true 改走 removeTreeVirtual 后序整棵删除，对齐桌面端
   *  plugin-fs 的递归删除语义。文件目标与 recursive=false 行为不变。 */
  async remove(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    const rv = params['recursive'];
    let recursive = false;
    if (typeof rv === 'boolean') {
      recursive = rv;
    }
    if (!recursive) {
      return this.permanentlyRemove(path);
    }
    let st: StatOut;
    try {
      st = await this.statOf(path);
    } catch (err) {
      throw this.wrapFsError(err, `删除失败（目标不存在） ${path}`);
    }
    if (!st.isDirectory) {
      return this.permanentlyRemove(path);
    }
    await this.removeTreeVirtual(path);
    return null;
  }

  /** app.trashFile（v4.13 P5）：移入应用回收站 /AppData/trash/<epochMs>-<原名>
   *  （应用沙箱内，用户文件管理器不可见——前端确认文案如实注明）。跨 URI/
   *  沙箱边界 rename 失败则复制后删原件（目录递归复制）。30 天启动清理见
   *  cleanupTrash。破坏性操作仍经 lib/fileOps 审计层（前端侧）。 */
  async trashFile(params: Record<string, Object>): Promise<Object | null> {
    const path = this.pathOf(params);
    let st: StatOut;
    try {
      st = await this.statOf(path);
    } catch (err) {
      throw this.wrapFsError(err, `删除失败（目标不存在） ${path}`);
    }
    const trashDirVirtual = '/AppData/trash';
    // /AppData 恒映射沙箱（UriMapper），这里直接拿真实路径建目录。
    const trashReal = this.mapper.resolve(trashDirVirtual).sandboxPath;
    this.ensureSandboxDir(trashReal);
    const base = this.baseNameOf(path);
    const now = Date.now();
    let targetVirtual = `${trashDirVirtual}/${now}-${base}`;
    for (let n = 1; n < 1000; n++) {
      if (!(await this.pathExistsVirtual(targetVirtual))) {
        break;
      }
      targetVirtual = `${trashDirVirtual}/${now}-${n}-${base}`;
    }
    const r = this.mapper.resolve(path);
    const from = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    const to = this.mapper.resolve(targetVirtual).sandboxPath;
    try {
      fs.renameSync(from, to);
      return null;
    } catch {
      // 跨边界 rename 不支持：复制到回收站后删原件。N13：整段纳入
      // try/catch（原裸 fs.rmdirSync/unlinkSync 抛 BusinessError，会被
      // Bridge.ets 归一为 E_INTERNAL 掩盖真相）；原件删除失败时先清理
      // 已复制的回收站副本，避免"原件 + 副本"双份中间态。
      try {
        if (st.isDirectory) {
          await this.copyTreeVirtual(path, targetVirtual);
          // 原件目录整棵递归删（fs.rmdirSync 不递归，非空目录直删必抛——
          // 同 N2；单删仅对空目录成立）。
          await this.removeTreeVirtual(path);
        } else {
          const bytes = await this.readBytes(path);
          await this.withWriteHandle(this.mapper.resolve(targetVirtual),
            (fd: number) => fs.writeSync(fd, bytes.buffer));
          fs.unlinkSync(from);
        }
      } catch (err) {
        // 清理失败吞掉（残留条目 30 天后由 cleanupTrash 兜底），原错误继续抛。
        await this.cleanupTrashArtifact(targetVirtual);
        if (err instanceof BridgeError) {
          throw err; // 已带语义（E_IO/E_PERMISSION）——不二次包装以免丢码
        }
        throw this.wrapFsError(err, `移入回收站失败 ${path}`);
      }
      return null;
    }
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
      // N27：按 UTF-8 字节数对比——st.size 是字节而 line.length 是 UTF-16
      // 码元数（中文 1 码元实占 3 字节），直接对比会让轮转系统性偏早触发；
      // 对齐桌面版 Rust append_log 的字节轮转语义。
      if (st.size + this.utf8ByteLen(line) > maxBytes) {
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
      // N8（最小版）：path/URI 直调一次系统调用（原 open→stat(fd)→close
      // 三连；stat 的重载支持沙箱路径与 file:// URI）——WatchManager 每
      // 2-5s 对 ≤5000 条目逐条轮询，成本直接降为 1/3。遗留：全部 fs.*Sync
      // 迁 TaskPool 不在本项范围（optimization_report2 6.1 后续批）。
      const st = fs.statSync(target);
      const out: StatOut = {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        // fs.Stat.mtime 即 epoch 毫秒（number），与桥协议 mtimeMs 对齐。
        mtimeMs: st.mtime,
      };
      return out;
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

  private baseNameOf(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx < 0 ? p : p.slice(idx + 1);
  }

  private async pathExistsVirtual(path: string): Promise<boolean> {
    try {
      await this.statOf(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 递归复制（虚拟路径层操作，URI/沙箱两侧都经 UriMapper 编解码）。 */
  private async copyTreeVirtual(fromV: string, toV: string): Promise<void> {
    const rec: Record<string, Object> = { 'path': fromV };
    const entries = await this.readDir(rec);
    await this.mkdir({ 'path': toV } as Record<string, Object>);
    const list = entries as DirEntryOut[];
    for (const e of list) {
      const src = `${fromV}/${e.name}`;
      const dst = `${toV}/${e.name}`;
      if (e.isDirectory) {
        await this.copyTreeVirtual(src, dst);
      } else {
        const bytes = await this.readBytes(src);
        await this.withWriteHandle(this.mapper.resolve(dst),
          (fd: number) => fs.writeSync(fd, bytes.buffer));
      }
    }
  }

  /** 递归整棵删除（虚拟路径层操作，URI/沙箱两侧都经 UriMapper 编解码）：
   *  后序遍历——readDir → 子目录递归 / 文件 unlinkSync → 出口 rmdirSync
   *  目录自身，遍历骨架与 copyTreeVirtual 同构。N2：fs.rmdirSync 单参
   *  不递归（非空目录直删必抛），recursive 删除必须自管理遍历。仅对
   *  目录调用；文件目标走 permanentlyRemove 单删。 */
  private async removeTreeVirtual(virtualPath: string): Promise<void> {
    const rec: Record<string, Object> = { 'path': virtualPath };
    const entries = await this.readDir(rec);
    const list = entries as DirEntryOut[];
    for (const e of list) {
      const child = `${virtualPath}/${e.name}`;
      if (e.isDirectory) {
        await this.removeTreeVirtual(child);
      } else {
        const cr = this.mapper.resolve(child);
        try {
          fs.unlinkSync(cr.kind === 'sandbox' ? cr.sandboxPath : cr.uri);
        } catch (err) {
          throw this.wrapFsError(err, `删除失败 ${child}`);
        }
      }
    }
    const r = this.mapper.resolve(virtualPath);
    try {
      fs.rmdirSync(r.kind === 'sandbox' ? r.sandboxPath : r.uri);
    } catch (err) {
      throw this.wrapFsError(err, `删除失败 ${virtualPath}`);
    }
  }

  /** N13：移入回收站失败时清理已复制的半成品（文件或目录均可）。尽力
   *  而为——任何清理失败都吞掉（残留条目 30 天后由 cleanupTrash 兜底），
   *  绝不掩盖调用方要上抛的原始错误。 */
  private async cleanupTrashArtifact(virtualPath: string): Promise<void> {
    try {
      const st = await this.statOf(virtualPath);
      if (st.isDirectory) {
        await this.removeTreeVirtual(virtualPath);
      } else {
        const r = this.mapper.resolve(virtualPath);
        fs.unlinkSync(r.kind === 'sandbox' ? r.sandboxPath : r.uri);
      }
    } catch {
      // 清理失败尽力而为，不影响原错误上抛。
    }
  }

  private decodeUtf8(bytes: Uint8Array): string {
    const decoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(bytes);
  }

  /** N27：行文本的 UTF-8 字节数。轮转上限 maxBytes 按字节计（st.size），
   *  对齐桌面版 Rust append_log 的字节语义；沿用仓内 TextEncoder 方案
   *  （同 S3Bridge.utf8Bytes），代理对（emoji 等）由编码器按 code point
   *  正确展开为 4 字节。 */
  private utf8ByteLen(line: string): number {
    const encoder = util.TextEncoder.create('utf-8');
    return encoder.encodeInto(line).length;
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

/** 启动清理应用回收站：删除 30 天前的条目（EntryAbility.onCreate 调用，
 *  尽力而为——任何失败都不拖垮启动）。条目名 <epochMs>-<原名>。
 *  W6 修复：目录条目改后序递归整棵删（原 fs.rmdirSync 单删，非空目录必抛
 *  被吞 → 回收站目录条目永远清不掉，只增不减）。 */
export function cleanupTrash(filesDir: string): void {
  migrateLegacyTrash(filesDir);
  const trashDir = `${filesDir}/trash`;
  try {
    if (!fs.accessSync(trashDir)) {
      return;
    }
  } catch {
    return;
  }
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let names: string[] = [];
  try {
    names = fs.listFileSync(trashDir);
  } catch {
    return;
  }
  for (const raw of names) {
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    if (name.length === 0) {
      continue;
    }
    const m = /^(\d+)-/.exec(name);
    if (m === null) {
      continue;
    }
    const t = Number(m[1]);
    if (Number.isNaN(t) || t >= cutoff) {
      continue;
    }
    try {
      const target = `${trashDir}/${name}`;
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        removeTreeReal(target);
      } else {
        fs.unlinkSync(target);
      }
    } catch {
      // 单条失败跳过 — 下次启动再试
    }
  }
}

/** 真实路径后序递归删除（cleanupTrash 专用；虚拟路径版见 FileManager
 *  removeTreeVirtual——那边经 UriMapper 编解码，这边直接操作沙箱路径）。 */
function removeTreeReal(dir: string): void {
  let names: string[] = [];
  try {
    names = fs.listFileSync(dir);
  } catch {
    // 读不出来直接尝试 rmdir（空目录/已消失仍能成功）
  }
  for (const raw of names) {
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    if (name.length === 0) {
      continue;
    }
    const child = `${dir}/${name}`;
    let isDir = false;
    try {
      isDir = fs.statSync(child).isDirectory();
    } catch {
      continue; // 条目消失：跳过
    }
    if (isDir) {
      removeTreeReal(child);
    } else {
      fs.unlinkSync(child);
    }
  }
  fs.rmdirSync(dir);
}

/** W8 修复的善后：UriMapper 沙箱拼接 bug 存续期（v4.13.0–v4.15.x），回收站
 *  被写到 `<filesDir>trash`（缺 `/`，实为 filesDir 同级的畸形目录名）而非
 *  `<filesDir>/trash`。这里一次性把整棵畸形目录改名搬进正确回收站（条目名
 *  打 legacy- 前缀 + 当前时间戳，30 天策略自然回收）。尽力而为，任何失败
 *  都不影响启动；首次成功后畸形目录不复存在，后续为 no-op。 */
function migrateLegacyTrash(filesDir: string): void {
  const legacy = `${filesDir}trash`;
  try {
    if (!fs.accessSync(legacy)) {
      return;
    }
    const trashDir = `${filesDir}/trash`;
    if (!fs.accessSync(trashDir)) {
      fs.mkdirSync(trashDir, true);
    }
    fs.renameSync(legacy, `${trashDir}/${Date.now()}-legacy-trash`);
  } catch {
    // 搬不动就留着（不阻塞启动；畸形目录不再增长——写入侧已修复）
  }
}
