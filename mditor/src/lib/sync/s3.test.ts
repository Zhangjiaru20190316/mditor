// 云同步 s3 原语封装的单测（§7.5.5 + §9）：
//   * isSyncSupported 三态判定（node 环境 detectRuntime 恒 tauri，必须显式
//     vi.mock 覆盖——platform/index 的缓存会让真实实现先落地）；
//   * 鸿蒙下全部原语 rejects UnsupportedError（消息含「桌面版」）；
//   * tauri 下 invoke 的命令名/参数组装正确（含 base64 上传编码）；
//   * parseSyncError 的「SYNC-XXX: …」解析与未知兜底。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeName } from "../../platform/types";

// 模块级 mock：detectRuntime / getAdapter 都是 s3.ts 的依赖。运行时值经
// mockRuntime 变量注入，每个用例按需切换。
let mockRuntime: RuntimeName = "tauri";
const invokeMock = vi.fn();

vi.mock("../../platform", () => ({
  detectRuntime: () => mockRuntime,
  getAdapter: () => ({ app: { invoke: invokeMock } }),
}));

import {
  isSyncSupported,
  parseSyncError,
  s3Delete,
  s3Get,
  s3Head,
  s3List,
  s3Put,
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
});

describe("isSyncSupported（运行时判定）", () => {
  it("tauri / browser 判 true", () => {
    mockRuntime = "tauri";
    expect(isSyncSupported()).toBe(true);
    mockRuntime = "browser";
    expect(isSyncSupported()).toBe(true);
  });

  it("harmony 判 false", () => {
    mockRuntime = "harmony";
    expect(isSyncSupported()).toBe(false);
  });
});

describe("鸿蒙降级守卫（§7.5.5）", () => {
  it("全部原语 rejects UnsupportedError 且消息含「桌面版」", async () => {
    mockRuntime = "harmony";
    const cases: Array<() => Promise<unknown>> = [
      () => s3TestConnection(CFG),
      () => s3List(CFG, "p/"),
      () => s3Get(CFG, "k"),
      () => s3Put(CFG, "k", new Uint8Array([1])),
      () => s3Delete(CFG, "k"),
      () => s3Head(CFG, "k"),
    ];
    for (const fn of cases) {
      await expect(fn()).rejects.toMatchObject({
        name: "UnsupportedError",
        message: expect.stringContaining("桌面版"),
      });
    }
    // 守卫在前：一次 invoke 都不该发出。
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

  it("s3Put base64 编码载荷（含中文路径键与 mtime）", async () => {
    invokeMock.mockResolvedValueOnce({ key: "k", size: 2, etag: "e", lastModified: "t" });
    await s3Put(CFG, "笔记 目录/a.md", new Uint8Array([104, 105]), 1234.5);
    expect(invokeMock).toHaveBeenCalledWith(
      "s3_put",
      expect.objectContaining({ key: "笔记 目录/a.md", data: "aGk=", mtimeMs: 1234.5 })
    );
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
