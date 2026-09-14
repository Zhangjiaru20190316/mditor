// 云同步 s3 原语封装的单测（§7.5.5 + §9；v4.13 起鸿蒙走 ArkTS 桥正路径）：
//   * isSyncSupported 三态判定（node 环境 detectRuntime 恒 tauri，必须显式
//     vi.mock 覆盖——platform/index 的缓存会让真实实现先落地）；
//   * 鸿蒙正路径：原语照常 invoke（ArkTS S3Bridge 代理）+ s3Get 的
//     {base64} 二进制适配（D4：fromBase64 复用鸿蒙适配层实现）+ 文件通道
//     的字节回落（s3PutFile/s3GetFile 读写字节后经适配层落盘）；
//   * browser 预览 rejects UnsupportedError（无平台后端）；
//   * tauri 下文件通道（v4.12.4）：s3PutFile/s3GetFile 走 Rust 直读直写，
//     只传路径不传字节；parseSyncError 的「SYNC-XXX: …」解析与未知兜底。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeName } from "../../platform/types";

// 模块级 mock：detectRuntime / getAdapter 都是 s3.ts 的依赖。运行时值经
// mockRuntime 变量注入，每个用例按需切换。
let mockRuntime: RuntimeName = "tauri";
const invokeMock = vi.fn();
const fsReadFileMock = vi.fn();
const fsWriteFileMock = vi.fn();
const fsExistsMock = vi.fn();
const fsMkdirMock = vi.fn();

vi.mock("../../platform", () => ({
  detectRuntime: () => mockRuntime,
  getAdapter: () => ({
    app: { invoke: invokeMock },
    fs: {
      readFile: fsReadFileMock,
      writeFile: fsWriteFileMock,
      exists: fsExistsMock,
      mkdir: fsMkdirMock,
    },
  }),
}));

import {
  isSyncSupported,
  parseSyncError,
  s3Delete,
  s3Get,
  s3GetFile,
  s3Head,
  s3List,
  s3PutFile,
  s3TestConnection,
} from "./s3";

const CFG = {
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "b",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  pathStyle: true,
};

beforeEach(() => {
  mockRuntime = "tauri";
  invokeMock.mockReset();
  fsReadFileMock.mockReset();
  fsWriteFileMock.mockReset();
  fsExistsMock.mockReset();
  fsMkdirMock.mockReset();
});

describe("isSyncSupported（运行时判定）", () => {
  it("tauri 判 true", () => {
    mockRuntime = "tauri";
    expect(isSyncSupported()).toBe(true);
  });

  it("harmony 判 true（ArkTS 桥代理）；browser 判 false", () => {
    mockRuntime = "harmony";
    expect(isSyncSupported()).toBe(true);
    mockRuntime = "browser";
    expect(isSyncSupported()).toBe(false);
  });
});

describe("鸿蒙正路径（v4.13：ArkTS S3Bridge 代理）", () => {
  it("原语照常 invoke——命令名与参数组装与 tauri 一致", async () => {
    mockRuntime = "harmony";
    invokeMock.mockResolvedValueOnce({ bucket: "b", endpoint: "e", region: "r" });
    await s3TestConnection(CFG);
    expect(invokeMock).toHaveBeenCalledWith("s3_test_connection", { cfg: CFG });

    invokeMock.mockResolvedValueOnce([]);
    await s3List(CFG, "mditor/");
    expect(invokeMock).toHaveBeenCalledWith("s3_list", { cfg: CFG, prefix: "mditor/" });

    invokeMock.mockResolvedValueOnce(null);
    await s3Head(CFG, "a.md");
    expect(invokeMock).toHaveBeenCalledWith("s3_head", { cfg: CFG, key: "a.md" });
  });

  it("s3Get 解码 {base64} 响应（D4：fromBase64 复用鸿蒙适配层）", async () => {
    mockRuntime = "harmony";
    invokeMock.mockResolvedValueOnce({ base64: "aGk=" });
    const out = await s3Get(CFG, "k");
    expect(out instanceof Uint8Array).toBe(true);
    expect(new TextDecoder().decode(out)).toBe("hi");
    expect(invokeMock).toHaveBeenCalledWith("s3_get", { cfg: CFG, key: "k" });
  });

  it("s3PutFile 鸿蒙回落：读字节 → base64 → s3_put（ArkTS 语义不变）", async () => {
    mockRuntime = "harmony";
    fsReadFileMock.mockResolvedValueOnce(new Uint8Array([104, 105]));
    invokeMock.mockResolvedValueOnce({ key: "k", size: 2, etag: "e", lastModified: "t" });
    await s3PutFile(CFG, "k", "C:/docs/a.md", 1234.5);
    expect(fsReadFileMock).toHaveBeenCalledWith("C:/docs/a.md");
    expect(invokeMock).toHaveBeenCalledWith(
      "s3_put",
      expect.objectContaining({ key: "k", data: "aGk=", mtimeMs: 1234.5 })
    );
  });

  it("s3GetFile 鸿蒙回落：s3_get → 适配层落盘（父目录存在时免 mkdir）", async () => {
    mockRuntime = "harmony";
    invokeMock.mockResolvedValueOnce({ base64: "aGk=" });
    fsExistsMock.mockResolvedValueOnce(true);
    await s3GetFile(CFG, "k", "C:/docs/a.md");
    expect(invokeMock).toHaveBeenCalledWith("s3_get", { cfg: CFG, key: "k" });
    expect(fsWriteFileMock).toHaveBeenCalledWith("C:/docs/a.md", expect.any(Uint8Array));
  });
});

describe("browser 预览守卫（无平台后端）", () => {
  it("全部原语 rejects UnsupportedError 且零 invoke", async () => {
    mockRuntime = "browser";
    const cases: Array<() => Promise<unknown>> = [
      () => s3TestConnection(CFG),
      () => s3List(CFG, "p/"),
      () => s3Get(CFG, "k"),
      () => s3GetFile(CFG, "k", "C:/f"),
      () => s3PutFile(CFG, "k", "C:/f"),
      () => s3Delete(CFG, "k"),
      () => s3Head(CFG, "k"),
    ];
    for (const fn of cases) {
      await expect(fn()).rejects.toMatchObject({ name: "UnsupportedError" });
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("tauri 下原语封装", () => {
  it("s3TestConnection / s3List / s3Head 透传 cfg 与参数", async () => {
    invokeMock.mockResolvedValueOnce({ bucket: "b" });
    await s3TestConnection(CFG);
    expect(invokeMock).toHaveBeenCalledWith("s3_test_connection", {
      cfg: CFG,
    });

    invokeMock.mockResolvedValueOnce([]);
    await s3List(CFG, "mditor/ws/");
    expect(invokeMock).toHaveBeenCalledWith("s3_list", {
      cfg: CFG,
      prefix: "mditor/ws/",
    });

    invokeMock.mockResolvedValueOnce(null);
    await s3Head(CFG, "a b.md");
    expect(invokeMock).toHaveBeenCalledWith("s3_head", { cfg: CFG, key: "a b.md" });
  });

  it("s3Get 把 ArrayBuffer 响应转 Uint8Array", async () => {
    invokeMock.mockResolvedValueOnce(
      new Uint8Array([104, 105]).buffer as ArrayBuffer
    );
    const out = await s3Get(CFG, "k");
    expect(out instanceof Uint8Array).toBe(true);
    expect(new TextDecoder().decode(out)).toBe("hi");
  });

  it("s3PutFile 文件通道：只传路径不传字节（v4.12.4 崩溃修复）", async () => {
    invokeMock.mockResolvedValueOnce({ key: "k", size: 2, etag: "e", lastModified: "t" });
    await s3PutFile(CFG, "笔记 目录/a.md", "C:/docs/笔记 目录/a.md", 1234.5);
    expect(invokeMock).toHaveBeenCalledWith(
      "s3_upload_file",
      expect.objectContaining({
        key: "笔记 目录/a.md",
        localPath: "C:/docs/笔记 目录/a.md",
        mtimeMs: 1234.5,
      })
    );
    // 字节不经前端：读文件/编码函数都不应被触达。
    expect(fsReadFileMock).not.toHaveBeenCalled();
  });

  it("s3GetFile 文件通道：只传 key 与目标路径", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await s3GetFile(CFG, "mditor/notes/a.md", "C:/ws/notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("s3_download_file", {
      cfg: CFG,
      key: "mditor/notes/a.md",
      destPath: "C:/ws/notes/a.md",
    });
    expect(fsWriteFileMock).not.toHaveBeenCalled();
  });

  it("s3Delete 无返回值", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await s3Delete(CFG, "k");
    expect(invokeMock).toHaveBeenCalledWith("s3_delete", { cfg: CFG, key: "k" });
  });
});

describe("parseSyncError（错误码映射）", () => {
  it("解析「SYNC-XXX: 消息」前缀形态", () => {
    expect(parseSyncError("SYNC-001: 凭证无效")).toEqual({
      code: "SYNC-001",
      message: "凭证无效",
    });
    expect(parseSyncError(new Error("SYNC-004: 请求超时"))).toEqual({
      code: "SYNC-004",
      message: "请求超时",
    });
  });

  it("无前缀的意外错误按 SYNC-999 归类并保留原文", () => {
    const out = parseSyncError("some webview failure");
    expect(out.code).toBe("SYNC-999");
    expect(out.message).toContain("webview failure");
  });
});
