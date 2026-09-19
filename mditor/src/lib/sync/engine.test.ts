// 云同步引擎单测（§9）：矩阵全覆盖、首同步、冲突三分支、幂等重入、忽略
// 规则、脏文件、删除传播。全部走内存桩（MemIO），不触达适配层。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesEqual,
  computeLocalState,
  computeRemoteState,
  conflictCopyName,
  createDefaultSyncIO,
  decideAction,
  fullPrefixOf,
  isContentEtag,
  remoteEpochMs,
  resolveRemoteDir,
  sameSecond,
  syncWorkspace,
  type EngineSideState,
  type LocalScanFile,
  type SyncIO,
} from "./engine";
import { readManifest, parseManifest, serializeManifest, emptyManifest, writeManifest, rootHash } from "./manifest";
import type { SyncManifest } from "./manifest";
import { isIgnoredName, isIgnoredRelPath, isTooDeep, isTooLarge } from "./ignore";
import type { S3Object, SyncManifestFile } from "./types";

// manifest.ts 的真实 IO 经平台适配层——这里 mock 一个内存版（读写文本文件）。
// 引擎本体只吃注入的 SyncIO，不受影响。
const memFiles = vi.hoisted(() => new Map<string, string>());
// D2 测试用：让 mock 的 readDir 对含该子串的路径抛错（默认不抛）。
const memFlags = vi.hoisted(() => ({ failReadDir: "" }));
vi.mock("../../platform", () => ({
  detectRuntime: () => "tauri",
  getAdapter: () => ({
    app: {
      appDataDir: async () => "C:/appdata",
      invoke: async () => {
        throw new Error("engine.test 不应触达真实 invoke");
      },
    },
    fs: {
      readTextFile: async (p: string) => {
        const v = memFiles.get(p);
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
      writeTextFile: async (p: string, c: string) => {
        memFiles.set(p, c);
      },
      exists: async (p: string) => memFiles.has(p),
      mkdir: async () => undefined,
      // D3：writeManifest 走 tmp+rename，rename 语义与真实适配层一致。
      rename: async (a: string, b: string) => {
        const v = memFiles.get(a);
        if (v === undefined) throw new Error("ENOENT");
        memFiles.delete(a);
        memFiles.set(b, v);
      },
      readDir: async (p: string) => {
        if (memFlags.failReadDir && p.includes(memFlags.failReadDir)) {
          throw new Error("EACCES: mocked readDir failure");
        }
        return [];
      },
    },
  }),
}));

// ---- 测试基建 ---------------------------------------------------------------

const CFG = {
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "test",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  pathStyle: true,
};
void CFG; // 连接配置经注入的 io 携带；保留作后续桩扩展锚点
const ROOT = "C:/ws/notes";
const PREFIX = "mditor/";
const FULL = `${PREFIX}notes/`;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 远端对象构造（key 为完整 key）。 */
function obj(key: string, content: string, lastModified: string, etag?: string): S3Object {
  const bytes = enc.encode(content);
  let h = 0;
  for (const b of bytes) h = (h * 31 + b) >>> 0;
  return {
    key,
    size: bytes.length,
    etag: etag ?? h.toString(16).padStart(32, "0"),
    lastModified,
  };
}

/** 内存桩：本地文件系统（含 app-data 暂存区）+ 远端对象存储 + manifest 存储。
 *  v4.12.4：引擎走「路径」通道（s3GetFile/s3PutFile/localFilesEqual...），
 *  字节不再经过 SyncIO 的调用参数——桩按 abs 路径在工作区 local 与暂存区
 *  tmp 两张表之间路由。 */
class MemIO implements SyncIO {
  local = new Map<string, { content: Uint8Array; mtimeMs: number }>();
  tmp = new Map<string, Uint8Array>();
  remote = new Map<string, S3Object & { content: Uint8Array }>();
  manifests = new Map<string, SyncManifest>();
  trash: Array<{ root: string; relPath: string }> = [];
  renames: Array<[string, string]> = [];
  // 故障注入：key 命中时对应操作抛错（幂等重入测试用）。
  failPut: Set<string> = new Set();

  /** 与 platform mock 的 appDataDir 一致（syncTempFile 的落点）。 */
  private static readonly TMP = "C:/appdata/sync/tmp";

  putLocal(relPath: string, content: string, mtimeMs = 1000_000): void {
    this.local.set(relPath, { content: enc.encode(content), mtimeMs });
  }
  putRemote(relPath: string, content: string, lastModified = "2026-09-13T10:00:00Z", mtimeMs = 1000_000): void {
    const key = `${FULL}${relPath}`;
    const o = obj(key, content, lastModified);
    this.remote.set(key, { ...o, content: enc.encode(content) });
    void mtimeMs;
  }

  private relOf(abs: string): string {
    return abs.replace(`${ROOT}/`, "");
  }
  private readAbs(abs: string): Uint8Array {
    if (abs.startsWith(MemIO.TMP)) {
      const v = this.tmp.get(abs);
      if (!v) throw new Error(`tmp miss: ${abs}`);
      return v;
    }
    const f = this.local.get(this.relOf(abs));
    if (!f) throw new Error(`local miss: ${abs}`);
    return f.content;
  }
  private writeAbs(abs: string, data: Uint8Array): void {
    if (abs.startsWith(MemIO.TMP)) {
      this.tmp.set(abs, data);
      return;
    }
    this.local.set(this.relOf(abs), { content: data, mtimeMs: 3000_000 });
  }

  async listLocal(): Promise<LocalScanFile[]> {
    const out: LocalScanFile[] = [];
    for (const [relPath, f] of this.local) {
      out.push({ relPath, mtimeMs: f.mtimeMs, size: f.content.length });
    }
    return out;
  }
  async s3List(prefix: string): Promise<S3Object[]> {
    return [...this.remote.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ key: k, size: v.size, etag: v.etag, lastModified: v.lastModified }));
  }
  async s3GetFile(key: string, destAbs: string): Promise<void> {
    const v = this.remote.get(key);
    if (!v) throw new Error("SYNC-999: not found");
    this.writeAbs(destAbs, v.content);
  }
  async s3PutFile(key: string, absPath: string, mtimeMs?: number): Promise<S3Object> {
    if (this.failPut.has(key)) throw new Error("SYNC-999: injected put failure");
    const data = this.readAbs(absPath);
    const etag = obj(key, dec.decode(data), "x").etag;
    const lastModified = new Date(mtimeMs ?? 2000_000).toISOString();
    const o = { key, size: data.length, etag, lastModified };
    this.remote.set(key, { ...o, content: data });
    return o;
  }
  async s3Delete(key: string): Promise<void> {
    this.remote.delete(key);
  }
  async readManifest(): Promise<SyncManifest | null> {
    return this.manifests.get(ROOT) ?? null;
  }
  async writeManifest(_root: string, m: SyncManifest): Promise<void> {
    this.manifests.set(ROOT, m);
  }
  async trashMove(_root: string, relPath: string): Promise<void> {
    this.trash.push({ root: _root, relPath });
    this.local.delete(relPath);
  }
  async statLocal(abs: string): Promise<{ mtimeMs: number; size: number } | null> {
    if (abs.startsWith(MemIO.TMP)) {
      const v = this.tmp.get(abs);
      return v ? { mtimeMs: 3000_000, size: v.length } : null;
    }
    const rel = this.relOf(abs);
    const f = this.local.get(rel);
    return f ? { mtimeMs: f.mtimeMs, size: f.content.length } : null;
  }
  async localFilesEqual(a: string, b: string): Promise<boolean> {
    const x = this.readAbs(a);
    const y = this.readAbs(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  async copyLocal(fromAbs: string, toAbs: string): Promise<void> {
    this.writeAbs(toAbs, this.readAbs(fromAbs));
  }
  async removeLocal(abs: string): Promise<void> {
    if (abs.startsWith(MemIO.TMP)) this.tmp.delete(abs);
    else this.local.delete(this.relOf(abs));
  }
  async syncTempFile(name: string): Promise<string> {
    return `${MemIO.TMP}/${name}`;
  }
  async renameLocal(a: string, b: string): Promise<void> {
    const ra = this.relOf(a);
    const rb = this.relOf(b);
    const f = this.local.get(ra);
    if (!f) throw new Error(`rename miss: ${ra}`);
    this.local.delete(ra);
    this.local.set(rb, f);
    this.renames.push([ra, rb]);
  }
}

async function run(io: MemIO) {
  const warnings: string[] = [];
  const states: Array<{ phase: string; total: number }> = [];
  const outcome = await syncWorkspace(ROOT, PREFIX, io, {
    onState: (e) => states.push({ phase: e.phase, total: e.total }),
    warn: (m) => warnings.push(m),
  });
  return { ...outcome, warnings, states };
}

let io: MemIO;
beforeEach(() => {
  io = new MemIO();
});

// ---- 纯函数 -----------------------------------------------------------------

describe("decideAction 矩阵全覆盖（§5.3 16 格 + absent 补全）", () => {
  const cases: Array<[EngineSideState, EngineSideState, string]> = [
    // 规格矩阵 4×4。
    ["same", "same", "skip"],
    ["same", "changed", "download"],
    ["same", "deleted", "deleteLocal"],
    ["same", "new", "download"],
    ["changed", "same", "upload"],
    ["changed", "changed", "conflict"],
    ["changed", "deleted", "upload"],
    ["changed", "new", "conflict"],
    ["deleted", "same", "deleteRemote"],
    ["deleted", "changed", "restoreLocal"],
    ["deleted", "deleted", "clearRecord"],
    ["deleted", "new", "conflict"], // 不可能* → 冲突兜底
    ["new", "same", "conflict"], // 不可能*
    ["new", "changed", "conflict"], // 不可能*
    ["new", "deleted", "conflict"], // 不可能*
    ["new", "new", "conflict"], // 首同步冲突
    // absent 补全。
    ["new", "absent", "upload"],
    ["absent", "new", "download"],
  ];
  for (const [l, r, expected] of cases) {
    it(`${l} × ${r} → ${expected}`, () => {
      expect(decideAction(l, r)).toBe(expected);
    });
  }
  it("全 absent 也不 panic（冲突兜底）", () => {
    expect(decideAction("absent", "absent")).toBe("conflict");
  });
});

describe("状态判定纯函数（§5.2）", () => {
  const rec = (over: Partial<SyncManifestFile> = {}): SyncManifestFile => ({
    local: { mtimeMs: 1000_000, size: 10, md5: null },
    remote: { etag: "e", size: 10, lastModified: "T" },
    ...over,
  });
  const present: LocalScanFile = { relPath: "a.md", mtimeMs: 1000_000, size: 10 };

  it("无记录：存在 = new，不存在 = absent", () => {
    expect(computeLocalState(present, undefined)).toBe("new");
    expect(computeLocalState(undefined, undefined)).toBe("absent");
  });

  it("有记录：缺失 = deleted；mtime 秒级取整比较", () => {
    expect(computeLocalState(undefined, rec())).toBe("deleted");
    // 同秒不同毫秒 → same（FS 精度容忍）。
    expect(computeLocalState({ ...present, mtimeMs: 1000_050 }, rec())).toBe("same");
    // 跨秒 → changed。
    expect(computeLocalState({ ...present, mtimeMs: 1001_500 }, rec())).toBe("changed");
    // size 变化 → changed。
    expect(computeLocalState({ ...present, size: 11 }, rec())).toBe("changed");
    expect(computeLocalState(present, rec())).toBe("same");
  });

  it("远端：etag/size/lastModified 任一变化 = changed；List 不到 = deleted", () => {
    const listed: S3Object = { key: "k", size: 10, etag: "e", lastModified: "T" };
    expect(computeRemoteState(listed, rec())).toBe("same");
    expect(computeRemoteState({ ...listed, etag: "e2" }, rec())).toBe("changed");
    expect(computeRemoteState({ ...listed, size: 11 }, rec())).toBe("changed");
    expect(computeRemoteState({ ...listed, lastModified: "T2" }, rec())).toBe("changed");
    expect(computeRemoteState(undefined, rec())).toBe("deleted");
    expect(computeRemoteState(listed, undefined)).toBe("new");
    expect(computeRemoteState(undefined, undefined)).toBe("absent");
  });
});

describe("冲突辅助纯函数", () => {
  it("isContentEtag：32hex 可比；multipart（-N）/大写引号形态不可比", () => {
    expect(isContentEtag("d41d8cd98f00b204e9800998ecf8427e")).toBe(true);
    expect(isContentEtag("d41d8cd98f00b204e9800998ecf8427e-2")).toBe(false);
    expect(isContentEtag(null)).toBe(false);
    expect(isContentEtag("short")).toBe(false);
  });

  it("conflictCopyName：<原名>.冲突-YYYYMMDD-HHmmss.<原扩展>", () => {
    const name = conflictCopyName("dir/a.md", new Date("2026-09-13T15:04:05").getTime());
    expect(name).toBe("dir/a.冲突-20260913-150405.md");
    const noExt = conflictCopyName("README", new Date("2026-09-13T15:04:05").getTime());
    expect(noExt).toBe("README.冲突-20260913-150405");
  });

  it("remoteEpochMs / bytesEqual / sameSecond 基础行为", () => {
    expect(remoteEpochMs("2026-09-13T10:00:00Z")).toBe(Date.UTC(2026, 8, 13, 10));
    expect(Number.isNaN(remoteEpochMs("garbage"))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameSecond(1000_999, 1000_001)).toBe(true);
  });
});

describe("忽略规则（§5.1）", () => {
  it("以 . 开头的名称/路径段被忽略", () => {
    expect(isIgnoredName(".git")).toBe(true);
    expect(isIgnoredName(".obsidian")).toBe(true);
    expect(isIgnoredName("normal.md")).toBe(false);
    expect(isIgnoredRelPath("a/.hidden/b.md")).toBe(true);
    expect(isIgnoredRelPath(".git/config")).toBe(true);
    expect(isIgnoredRelPath("a/b.md")).toBe(false);
    expect(isIgnoredRelPath("")).toBe(true);
  });
  it("深度与大小上限", () => {
    expect(isTooDeep("a/b.md")).toBe(false);
    expect(isTooDeep(Array(33).fill("d").join("/") + "/f.md")).toBe(true);
    expect(isTooLarge(50 * 1024 * 1024)).toBe(false);
    expect(isTooLarge(50 * 1024 * 1024 + 1)).toBe(true);
  });
});

// ---- 编排（内存桩全链路）----------------------------------------------------

describe("syncWorkspace：首同步（验收 2）", () => {
  it("本地文件（含中文/空格/嵌套）上传到 <prefix>/<根目录名>/", async () => {
    io.putLocal("a.md", "A");
    io.putLocal("笔记 目录/空 格.md", "中文内容");
    io.putLocal("d1/d2/deep.md", "D");
    const { summary, firstSync } = await run(io);
    expect(firstSync).toBe(true);
    expect(summary.uploaded).toBe(3);
    expect(io.remote.get(`${FULL}a.md`)).toBeDefined();
    expect(dec.decode(io.remote.get(`${FULL}笔记 目录/空 格.md`)!.content)).toBe("中文内容");
    expect(io.remote.get(`${FULL}d1/d2/deep.md`)).toBeDefined();
  });

  it("远端对象（另一机器首同步视角）下载落盘", async () => {
    io.putRemote("from-remote.md", "R");
    const { summary } = await run(io);
    expect(summary.downloaded).toBe(1);
    expect(dec.decode(io.local.get("from-remote.md")!.content)).toBe("R");
  });

  it("远端隐藏对象（. 开头）不动；本地隐藏文件不上传", async () => {
    io.putLocal(".secret.md", "s");
    io.putRemote(".git/config", "x");
    io.putRemote("normal.md", "n");
    const { summary } = await run(io);
    expect(summary.uploaded).toBe(0);
    expect(summary.downloaded).toBe(1);
    expect(io.local.get(".git/config")).toBeUndefined();
  });
});

describe("远端目录名覆盖（键收敛：鸿蒙 token → 真实文件夹名）", () => {
  it("resolveRemoteDir：覆盖生效；消毒去首尾斜杠；空/越界回退 basename", () => {
    expect(resolveRemoteDir("C:/ws/notes")).toBe("notes");
    expect(resolveRemoteDir("C:/ws/notes", "笔记")).toBe("笔记");
    expect(resolveRemoteDir("C:/ws/notes", "/笔记/")).toBe("笔记");
    expect(resolveRemoteDir("/Docs/ws-1", "C语言")).toBe("C语言");
    expect(resolveRemoteDir("/Docs/ws-1", "")).toBe("ws-1");
    expect(resolveRemoteDir("/Docs/ws-1", "  ")).toBe("ws-1");
    expect(resolveRemoteDir("/Docs/ws-1", "a/b")).toBe("ws-1");
    expect(resolveRemoteDir("/Docs/ws-1", "..")).toBe("ws-1");
  });

  it("fullPrefixOf：覆盖与回退同源（引擎与指纹共用推导）", () => {
    expect(fullPrefixOf("mditor/", "C:/ws/notes")).toBe("mditor/notes/");
    expect(fullPrefixOf("mditor/", "/Docs/ws-1", "C语言")).toBe("mditor/C语言/");
  });

  it("remoteDir 覆盖上传/下载前缀（同名配对两视角共用 mditor/<真实名>/）", async () => {
    // 鸿蒙视角：root basename 是 token，覆盖为真实名「C语言」→ 上传换前缀。
    io.putLocal("a.md", "A");
    const outcome = await syncWorkspace(ROOT, PREFIX, io, {
      onState: () => {},
      warn: () => {},
    }, undefined, "C语言");
    expect(outcome.summary.uploaded).toBe(1);
    expect(io.remote.get("mditor/C语言/a.md")).toBeDefined();
    expect(io.remote.get("mditor/notes/a.md")).toBeUndefined();

    // 配对视角：对端同名工作区的对象按同一前缀下载落盘（absent|new → download）。
    const o2 = obj("mditor/C语言/from-remote.md", "R", "2026-09-13T10:00:00Z");
    io.remote.set("mditor/C语言/from-remote.md", { ...o2, content: enc.encode("R") });
    const second = await syncWorkspace(ROOT, PREFIX, io, {
      onState: () => {},
      warn: () => {},
    }, undefined, "C语言");
    expect(second.summary.downloaded).toBe(1);
    expect(io.local.get("from-remote.md")).toBeDefined();
  });
});

describe("syncWorkspace：矩阵行为（有清单基线）", () => {
  /** 建立基线：一轮首同步后返回第二台的 io 视角。 */
  async function baseline(files: Array<[string, string]>) {
    for (const [p, c] of files) io.putLocal(p, c);
    await run(io);
    return io.manifests.get(ROOT)!;
  }

  it("二次同步零操作（验收 3）", async () => {
    await baseline([
      ["a.md", "A"],
      ["b.md", "B"],
    ]);
    const { summary } = await run(io);
    expect(summary.uploaded + summary.downloaded + summary.deletedLocal + summary.deletedRemote).toBe(0);
  });

  it("same×changed → 下载覆盖本地", async () => {
    await baseline([["a.md", "A"]]);
    io.putRemote("a.md", "A2", "2026-09-13T12:00:00Z");
    const { summary } = await run(io);
    expect(summary.downloaded).toBe(1);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("A2");
  });

  it("changed×same → 上传（A 机改动 → B 机视角下载，验收 4）", async () => {
    await baseline([["a.md", "A"]]);
    io.putLocal("a.md", "A-local-edit", 2000_000);
    const { summary } = await run(io);
    expect(summary.uploaded).toBe(1);
    expect(dec.decode(io.remote.get(`${FULL}a.md`)!.content)).toBe("A-local-edit");
    // 模拟 B 机（新 manifest）：只有远端 → 下载。
    const ioB = new MemIO();
    ioB.remote = io.remote;
    const outB = await run(ioB);
    expect(outB.summary.downloaded).toBe(1);
    expect(dec.decode(ioB.local.get("a.md")!.content)).toBe("A-local-edit");
  });

  it("same×deleted → 删本地（入回收站，验收 6 后半）", async () => {
    await baseline([["a.md", "A"]]);
    io.remote.delete(`${FULL}a.md`);
    const { summary } = await run(io);
    expect(summary.deletedLocal).toBe(1);
    expect(io.local.has("a.md")).toBe(false);
    expect(io.trash).toEqual([{ root: ROOT, relPath: "a.md" }]);
  });

  it("deleted×same → 删远端（本地删除传播，验收 6 前半）", async () => {
    await baseline([["a.md", "A"]]);
    io.local.delete("a.md");
    const { summary } = await run(io);
    expect(summary.deletedRemote).toBe(1);
    expect(io.remote.has(`${FULL}a.md`)).toBe(false);
  });

  it("deleted×changed → 下载恢复", async () => {
    await baseline([["a.md", "A"]]);
    io.local.delete("a.md");
    io.putRemote("a.md", "A-remote-new", "2026-09-13T12:00:00Z");
    const { summary } = await run(io);
    expect(summary.downloaded).toBe(1);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("A-remote-new");
  });

  it("deleted×deleted → 清除记录（幂等）", async () => {
    await baseline([["a.md", "A"]]);
    io.local.delete("a.md");
    io.remote.delete(`${FULL}a.md`);
    const { summary } = await run(io);
    expect(summary.uploaded + summary.downloaded).toBe(0);
    expect(io.manifests.get(ROOT)!.files["a.md"]).toBeUndefined();
  });

  it("changed×deleted → 改动胜过删除（上传）", async () => {
    await baseline([["a.md", "A"]]);
    io.putLocal("a.md", "A-edited", 2000_000);
    io.remote.delete(`${FULL}a.md`);
    const { summary } = await run(io);
    expect(summary.uploaded).toBe(1);
    expect(dec.decode(io.remote.get(`${FULL}a.md`)!.content)).toBe("A-edited");
  });
});

describe("syncWorkspace：冲突三分支（验收 5）", () => {
  // 时间锚点：本地 mtime 与远端 lastModified 都用真实量级的 epoch ms。
  const T2026 = Date.UTC(2026, 8, 13, 12, 0, 0);
  const T2020 = Date.UTC(2020, 0, 1);

  async function conflicting(localContent: string, remoteContent: string, lMtime: number, rIso: string) {
    io.putLocal("a.md", "BASE");
    await run(io); // 基线
    io.putLocal("a.md", localContent, lMtime);
    io.putRemote("a.md", remoteContent, rIso);
    return run(io);
  }

  it("分支 1：内容相同 → 无副本，新者覆盖另一侧", async () => {
    const same = "BOTH";
    const { summary } = await conflicting(same, same, T2020, "2026-09-13T12:00:00Z");
    expect(summary.conflicts).toBe(1);
    // 远端更新（2026 > 2020）→ 下载远端覆盖本地。
    expect(summary.downloaded).toBe(1);
    expect(summary.uploaded).toBe(0);
    // 无任何 .冲突- 副本。
    expect([...io.local.keys()].some((k) => k.includes("冲突"))).toBe(false);
    expect([...io.remote.keys()].some((k) => k.includes("冲突"))).toBe(false);
  });

  it("分支 2 本地胜：远端旧内容存副本并上传，本地为正主", async () => {
    const { summary } = await conflicting("LOCAL-NEW", "REMOTE-OLD", T2026, "2020-01-01T00:00:00Z");
    expect(summary.conflicts).toBe(1);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("LOCAL-NEW");
    expect(dec.decode(io.remote.get(`${FULL}a.md`)!.content)).toBe("LOCAL-NEW");
    const copy = [...io.local.keys()].find((k) => k.includes("冲突"));
    expect(copy).toBeDefined();
    expect(dec.decode(io.local.get(copy!)!.content)).toBe("REMOTE-OLD");
    // 副本双端可见。
    expect(io.remote.get(`${FULL}${copy}`)).toBeDefined();
    expect(dec.decode(io.remote.get(`${FULL}${copy}`)!.content)).toBe("REMOTE-OLD");
  });

  it("分支 2 远端胜：本地旧内容改名副本并上传，远端为正主", async () => {
    const { summary } = await conflicting("LOCAL-OLD", "REMOTE-NEW", T2020, "2030-01-01T00:00:00Z");
    expect(summary.conflicts).toBe(1);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("REMOTE-NEW");
    expect(dec.decode(io.remote.get(`${FULL}a.md`)!.content)).toBe("REMOTE-NEW");
    const copy = [...io.local.keys()].find((k) => k.includes("冲突"));
    expect(copy).toBeDefined();
    expect(dec.decode(io.local.get(copy!)!.content)).toBe("LOCAL-OLD");
    expect(dec.decode(io.remote.get(`${FULL}${copy}`)!.content)).toBe("LOCAL-OLD");
  });

  it("分支 3：时间接近无法判定 → 远端胜 + note 人工确认", async () => {
    // 本地 mtime 与远端 lastModified 同秒。
    const { summary } = await conflicting("L", "R", T2026, "2026-09-13T12:00:00Z");
    expect(summary.conflicts).toBe(1);
    expect(summary.notes.some((n) => n.includes("请人工确认"))).toBe(true);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("R");
  });

  it("首同步两边同名同内容 → 无副本按新者覆盖", async () => {
    io.putLocal("a.md", "SAME");
    io.putRemote("a.md", "SAME", "2026-09-13T12:00:00Z");
    const { summary } = await run(io);
    expect(summary.conflicts).toBe(1);
    expect([...io.local.keys()].some((k) => k.includes("冲突"))).toBe(false);
  });

  it("首同步两边同名不同内容 → 冲突副本可见", async () => {
    io.putLocal("a.md", "L1", T2026);
    io.putRemote("a.md", "R1", "2020-01-01T00:00:00Z");
    const { summary } = await run(io);
    expect(summary.conflicts).toBe(1);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("L1");
    const copy = [...io.local.keys()].find((k) => k.includes("冲突"));
    expect(dec.decode(io.local.get(copy!)!.content)).toBe("R1");
  });
});

describe("syncWorkspace：脏文件 / 超限 / 幂等重入", () => {
  it("编辑中的脏文件不被远端覆盖（跳过 + 警告，验收 8）", async () => {
    io.putLocal("a.md", "A");
    await run(io); // 基线
    io.putRemote("a.md", "A-remote", "2026-09-13T12:00:00Z");
    // 扫描瞬间报告基线快照（旧 mtime/size），随后用户开始编辑（磁盘 mtime
    // 更新 + 内容变化）——下载前重 stat 必须发现并跳过。
    io.putLocal("a.md", "B", 9000_000);
    const realList = io.listLocal.bind(io);
    io.listLocal = async () => {
      const files = await realList();
      return files.map((f) => (f.relPath === "a.md" ? { ...f, mtimeMs: 1000_000, size: 1 } : f));
    };
    const { summary, warnings } = await run(io);
    expect(summary.skipped).toBe(1);
    expect(summary.downloaded).toBe(0);
    expect(warnings.some((w) => w.includes("脏文件"))).toBe(true);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("B");
  });

  it(">50MB 本地大文件：冻结不误删远端（防误删红线）", async () => {
    io.putLocal("big.bin", "small");
    await run(io); // 基线（正常同步）
    // 文件长大后超限：键被冻结——远端对象不删、记录保留。
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    io.local.set("big.bin", { content: big, mtimeMs: 5000_000 });
    const { summary, warnings } = await run(io);
    expect(summary.skipped).toBe(1);
    expect(warnings.some((w) => w.includes("50MB"))).toBe(true);
    expect(io.remote.has(`${FULL}big.bin`)).toBe(true);
    // 记录保留（下次缩回限内可继续同步）。
    expect(io.manifests.get(ROOT)!.files["big.bin"]).toBeDefined();
  });

  it("远端对象超限同样冻结（不下载覆盖本地）", async () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 2);
    io.remote.set(`${FULL}big-remote.bin`, {
      key: `${FULL}big-remote.bin`,
      size: big.length,
      etag: "e",
      lastModified: "2026-09-13T12:00:00Z",
      content: big,
    });
    const { summary } = await run(io);
    expect(summary.skipped).toBe(1);
    expect(summary.downloaded).toBe(0);
    expect(io.local.has("big-remote.bin")).toBe(false);
  });

  it("幂等重入：上传中途失败后重跑，结果与一次成功等价（§9）", async () => {
    io.putLocal("a.md", "A");
    io.putLocal("b.md", "B");
    // 首同步中途失败：b 的上传注入失败。
    io.failPut.add(`${FULL}b.md`);
    const r1 = await run(io);
    expect(r1.summary.uploaded).toBe(1);
    expect(r1.summary.failed).toBe(1);
    // 清除故障重跑：a 已同步（跳过），b 补传；终态 manifest 与单次成功等价。
    io.failPut.clear();
    const r2 = await run(io);
    expect(r2.summary.uploaded).toBe(1);
    const m = io.manifests.get(ROOT)!;
    expect(Object.keys(m.files).sort()).toEqual(["a.md", "b.md"]);
    expect(dec.decode(io.remote.get(`${FULL}b.md`)!.content)).toBe("B");
  });
});

describe("manifest 读写与迁移（§4.2）", () => {
  it("rootHash 稳定且对分隔符/大小态归一", async () => {
    const a = await rootHash("C:\\WS\\Notes");
    const b = await rootHash("c:/ws/notes");
    const c = await rootHash("c:/ws/other");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("parse/serialize 往返；损坏与版本不识别 → null", () => {
    const m = emptyManifest("C:/ws");
    m.files["a.md"] = {
      local: { mtimeMs: 1, size: 2, md5: null },
      remote: null,
    };
    const back = parseManifest(serializeManifest(m));
    expect(back).toEqual(m);
    expect(parseManifest("{broken json")).toBeNull();
    expect(parseManifest(JSON.stringify({ ...m, version: 99 }))).toBeNull();
    // 双 null 无意义记录被剔除。
    const dirty = { ...m, files: { "x": { local: null, remote: null } } };
    expect(parseManifest(JSON.stringify(dirty))!.files["x"]).toBeUndefined();
  });

  it("readManifest/writeManifest 经适配层往返；不存在 → null（首同步语义）", async () => {
    expect(await readManifest("C:/ws/empty")).toBeNull();
    const m = emptyManifest("C:/ws/rt");
    m.files["a.md"] = { local: { mtimeMs: 1, size: 2, md5: null }, remote: null };
    await writeManifest("C:/ws/rt", m);
    expect(await readManifest("C:/ws/rt")).toEqual(m);
  });

  it("D3：writeManifest 走 tmp+rename（不留可被误读的半份清单）", async () => {
    const m = emptyManifest("C:/ws/atomic");
    await writeManifest("C:/ws/atomic", m);
    const hash = await rootHash("C:/ws/atomic");
    const finalPath = `C:/appdata/sync/manifests/${hash}.json`;
    // rename 已消费 tmp：终态只有正式清单，无 .tmp 残件。
    expect(memFiles.has(finalPath)).toBe(true);
    expect(memFiles.has(`${finalPath}.tmp`)).toBe(false);
  });
});

// ---- D1/D2/D4 数据安全回归 --------------------------------------------------

describe("D1/D2/D4 数据安全回归", () => {
  const HOOKS = { onState: () => {}, warn: () => {} };

  /** 按当前 io 的 local/remote 内容构造「已同步」清单（same|same 基线）。 */
  function syncedManifest(i: MemIO, rels: string[]): SyncManifest {
    const m = emptyManifest(ROOT);
    m.lastSyncAt = 1_000;
    for (const rel of rels) {
      const l = i.local.get(rel);
      const o = i.remote.get(`${FULL}${rel}`)!;
      expect(l).toBeDefined();
      m.files[rel] = {
        local: { mtimeMs: l!.mtimeMs, size: l!.content.length, md5: null },
        remote: { etag: o.etag ?? "", size: o.size, lastModified: o.lastModified },
      };
    }
    return m;
  }

  it("D1：远端被清空 → 批量删除保险中止，本地/远端/清单零改动", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `f${i}.md`);
    for (const k of keys) {
      io.putLocal(k, "v");
      io.putRemote(k, "v");
    }
    io.manifests.set(ROOT, syncedManifest(io, keys));
    io.remote.clear(); // 生命周期规则清空 / 指错了空桶

    const r = await syncWorkspace(ROOT, PREFIX, io, HOOKS, "fp-1");
    expect(r.aborted).toBe("mass-delete");
    expect(io.trash).toHaveLength(0); // 一个文件都没进回收站
    expect(io.local.size).toBe(10); // 本地文件原样
    expect(io.manifests.get(ROOT)!.lastSyncAt).toBe(1_000); // 清单未被改写
    expect(r.summary.notes.join()).toContain("已中止");
  });

  it("D1：少量删除（<5 个）不触发保险，正常同步", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `f${i}.md`);
    for (const k of keys) {
      io.putLocal(k, "v");
      io.putRemote(k, "v");
    }
    io.manifests.set(ROOT, syncedManifest(io, keys));
    io.local.delete("f0.md"); // 用户真的删了 1 个 → deleteRemote

    const r = await syncWorkspace(ROOT, PREFIX, io, HOOKS, "fp-1");
    expect(r.aborted).toBeUndefined();
    expect(r.summary.deletedRemote).toBe(1);
  });

  it("D1：换桶/换前缀（指纹失配）→ 按首同步重算，绝不产生删除", async () => {
    const keys = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"];
    for (const k of keys) {
      io.putLocal(k, "v");
      io.putRemote(k, "v");
    }
    io.manifests.set(ROOT, { ...syncedManifest(io, keys), remoteFingerprint: "fp-OLD" });

    const r = await syncWorkspace(ROOT, PREFIX, io, HOOKS, "fp-NEW");
    expect(r.firstSync).toBe(true);
    expect(r.summary.deletedLocal).toBe(0);
    expect(r.summary.deletedRemote).toBe(0);
    expect(io.trash).toHaveLength(0);
    // 首同步后新指纹落盘。
    expect(io.manifests.get(ROOT)!.remoteFingerprint).toBe("fp-NEW");
  });

  it("D1 兼容：旧清单无指纹字段 → 按匹配处理（升级不引发全量冲突），本轮补写指纹", async () => {
    const keys = ["a.md", "b.md"];
    for (const k of keys) {
      io.putLocal(k, "v");
      io.putRemote(k, "v");
    }
    io.manifests.set(ROOT, syncedManifest(io, keys)); // 无 remoteFingerprint

    const r = await syncWorkspace(ROOT, PREFIX, io, HOOKS, "fp-1");
    expect(r.firstSync).toBe(false);
    expect(r.summary.conflicts).toBe(0);
    expect(io.manifests.get(ROOT)!.remoteFingerprint).toBe("fp-1");
  });

  it("D2：本地扫描读失败 → 中止本轮，远端零改动、清单不落盘", async () => {
    class ScanFailIO extends MemIO {
      override async listLocal(): Promise<LocalScanFile[]> {
        throw new Error("SYNC-SCAN-READFAIL: 目录不可读（mocked）");
      }
    }
    const sio = new ScanFailIO();
    const keys = Array.from({ length: 6 }, (_, i) => `g${i}.md`);
    for (const k of keys) {
      sio.putLocal(k, "v");
      sio.putRemote(k, "v");
    }
    sio.manifests.set(ROOT, syncedManifest(sio, keys));

    await expect(syncWorkspace(ROOT, PREFIX, sio, HOOKS, "fp-1")).rejects.toThrow(
      /SYNC-SCAN-READFAIL/
    );
    expect(sio.remote.size).toBe(6); // 远端一个都没删
    expect(sio.local.size).toBe(6); // 本地原样
    expect(sio.trash).toHaveLength(0);
    expect(sio.manifests.get(ROOT)!.lastSyncAt).toBe(1_000); // 清单未被改写
  });

  it("D2（默认 IO）：readDir 失败不再被吞成空目录，抛 SYNC-SCAN-READFAIL", async () => {
    memFlags.failReadDir = "notes";
    try {
      const dio = createDefaultSyncIO(CFG);
      await expect(dio.listLocal("C:/ws/notes")).rejects.toThrow(/SYNC-SCAN-READFAIL/);
    } finally {
      memFlags.failReadDir = "";
    }
  });

  it("D4：扫描时不存在、下载前被新建的文件不会被远端覆盖（TOCTOU 守卫）", async () => {
    // 清单记录 a.md 双侧 same，但远端已变（changed）+ 本地已删（deleted）
    // → deleted|changed = restoreLocal → 走 doDownload。
    io.putRemote("a.md", "远端新内容", "2026-09-14T10:00:00Z");
    io.manifests.set(
      ROOT,
      {
        ...emptyManifest(ROOT),
        lastSyncAt: 1_000,
        files: {
          "a.md": {
            local: { mtimeMs: 1000_000, size: 2, md5: null },
            remote: { etag: "old-etag", size: 2, lastModified: "2026-09-13T10:00:00Z" },
          },
        },
      }
    );
    // 扫描时本地无 a.md；首次 statLocal（即 doDownload 内）之前用户重建了它。
    const realStat = io.statLocal.bind(io);
    let injected = false;
    io.statLocal = async (abs: string) => {
      if (!injected) {
        injected = true;
        io.putLocal("a.md", "用户新建内容", 5000_000);
      }
      return realStat(abs);
    };

    const r = await syncWorkspace(ROOT, PREFIX, io, HOOKS);
    expect(dec.decode(io.local.get("a.md")!.content)).toBe("用户新建内容");
    expect(r.summary.skipped).toBeGreaterThanOrEqual(1);
  });
});
