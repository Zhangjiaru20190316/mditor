// 云同步触发器单测（§7.5.5 + §9；v4.13 起鸿蒙同路径装配）：browser 零装配
// （定时器/监听注册桩计数为 0）、harmony/tauri 装配/销毁、sync-request 转发、
// offline 判定。
//
// node 环境 detectRuntime 恒按 tauri 处理——必须显式 vi.mock 覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeName } from "../../platform/types";
import type { Settings } from "../../types";

let mockRuntime: RuntimeName = "tauri";
// 平台桩：listen/emit/invoke 全部可断言；fs 为最小内存实现（manifest 读写
// 与本地扫描走通；所有引用都在函数体内惰性求值，vi.mock 提升安全）。
type ListenFn = (
  event: string,
  handler: (ev: { payload: unknown }) => void
) => Promise<() => void>;
const listenMock = vi.fn<ListenFn>(async () => () => undefined);
const emitMock = vi.fn(
  async (_event: string, _payload?: unknown): Promise<void> => undefined
);
const invokeMock = vi.fn(
  async (_command: string, _args?: unknown): Promise<unknown> => {
    throw new Error("trigger.test: unexpected invoke");
  }
);
// D1 逃生门确认框桩（缺省拒绝 = 安全缺省）。
const confirmMock = vi.fn(async (_content: string, _options?: unknown): Promise<boolean> => false);
const memFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("../../platform", () => ({
  detectRuntime: () => mockRuntime,
  getAdapter: () => ({
    app: {
      listen: listenMock,
      emit: emitMock,
      invoke: invokeMock,
      appDataDir: async () => "C:/appdata",
    },
    dialog: {
      confirm: confirmMock,
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
      readDir: async () => [],
      stat: async () => {
        throw new Error("ENOENT");
      },
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: async () => undefined,
      // writeManifest 是 tmp+rename 原子写：rename 必须真正搬移内容，否则
      // 清单永远停在 .tmp，readManifest 读到 null（首同步语义）。
      rename: async (a: string, b: string) => {
        if (!memFiles.has(a)) throw new Error("ENOENT");
        memFiles.set(b, memFiles.get(a)!);
        memFiles.delete(a);
      },
    },
  }),
}));

import { assembleSyncTrigger } from "./trigger";
import { emptyManifest, remoteFingerprint, writeManifest } from "./manifest";
import { fullPrefixOf } from "./engine";
import { syncConfigPayload } from "./s3";
import { DEFAULT_SETTINGS } from "../../defaults";

function settingsWith(sync: Partial<Settings["sync"]>): Settings {
  return { ...DEFAULT_SETTINGS, sync: { ...DEFAULT_SETTINGS.sync, ...sync } };
}

const intervalSpy = vi.spyOn(globalThis, "setInterval");
const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

beforeEach(() => {
  mockRuntime = "tauri";
  listenMock.mockClear();
  emitMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => {
    throw new Error("trigger.test: unexpected invoke");
  });
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => false);
  intervalSpy.mockClear();
  timeoutSpy.mockClear();
  memFiles.clear();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("browser 零装配（§7.5.5）", () => {
  it("assembleSyncTrigger 返回 null：零定时器、零监听注册", () => {
    mockRuntime = "browser";
    const t = assembleSyncTrigger({
      getSettings: () => settingsWith({ enabled: true }),
      getRoots: () => ["C:/ws"],
    });
    expect(t).toBeNull();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe("harmony 同路径装配（v4.13：ArkTS S3Bridge 代理）", () => {
  it("与 tauri 一致：挂定时器、启动延迟与 sync-request 监听", () => {
    mockRuntime = "harmony";
    const t = assembleSyncTrigger({
      getSettings: () =>
        settingsWith({ enabled: true, autoSync: true, autoSyncIntervalMin: 10, syncOnStart: true }),
      getRoots: () => ["C:/ws"],
    });
    expect(t).not.toBeNull();
    expect(intervalSpy).toHaveBeenCalled();
    expect(timeoutSpy).toHaveBeenCalled();
    expect(listenMock).toHaveBeenCalledWith("sync-request", expect.any(Function));
    t?.dispose();
  });
});

describe("tauri 装配", () => {
  it("按设置挂定时器（自动同步间隔）与启动延迟，注册 sync-request 监听", () => {
    const t = assembleSyncTrigger({
      getSettings: () =>
        settingsWith({ enabled: true, autoSync: true, autoSyncIntervalMin: 10, syncOnStart: true }),
      getRoots: () => ["C:/ws"],
    });
    expect(t).not.toBeNull();
    // 间隔定时器（10min）+ 启动延迟（15s）。
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(listenMock).toHaveBeenCalledWith("sync-request", expect.any(Function));
    t!.dispose();
  });

  it("autoSync 关闭/间隔 0：无间隔定时器", () => {
    const t = assembleSyncTrigger({
      getSettings: () => settingsWith({ enabled: true, autoSync: false, autoSyncIntervalMin: 0, syncOnStart: false }),
      getRoots: () => ["C:/ws"],
    });
    expect(t).not.toBeNull();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    t!.dispose();
  });

  it("dispose 注销 sync-request 监听", async () => {
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce(async () => unlisten);
    const t = assembleSyncTrigger({
      getSettings: () => settingsWith({ enabled: true, autoSync: false, syncOnStart: false }),
      getRoots: () => [],
    });
    t!.dispose();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });
});

describe("sync-request 转发与同步执行", () => {
  it("sync-request 事件 → 引擎执行（invoke 发出 s3_list，广播 syncing→idle）", async () => {
    invokeMock.mockImplementation(async (cmd: string): Promise<unknown> => {
      if (cmd === "s3_list") return [];
      throw new Error(`unexpected ${cmd}`);
    });
    let handler: ((ev: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementationOnce(async (_e, h) => {
      handler = h;
      return () => undefined;
    });
    const t = assembleSyncTrigger({
      getSettings: () => settingsWith({ enabled: true, autoSync: false, syncOnStart: false }),
      getRoots: () => ["C:/ws/notes"],
    });
    expect(handler).not.toBeNull();
    handler!({ payload: undefined });
    // 等同步链路（含 emit 微任务）完成。
    await new Promise((r) => setTimeout(r, 30));
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("s3_list");
    const events = emitMock.mock.calls
      .filter((c) => c[0] === "sync-state")
      .map((c) => c[1] as import("./types").SyncStateEvent);
    expect(events.some((e) => e.status === "syncing")).toBe(true);
    expect(events[events.length - 1].status).toBe("idle");
    t!.dispose();
  });

  it("连续 2 次网络错误 → offline 状态广播", async () => {
    invokeMock.mockImplementation(async (cmd: string): Promise<unknown> => {
      if (cmd === "s3_list") throw new Error("SYNC-003: 网络不可达或连接被拒");
      throw new Error(`unexpected ${cmd}`);
    });
    let handler: ((ev: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementationOnce(async (_e, h) => {
      handler = h;
      return () => undefined;
    });
    const t = assembleSyncTrigger({
      getSettings: () => settingsWith({ enabled: true, autoSync: false, syncOnStart: false }),
      getRoots: () => ["C:/ws/notes"],
    });
    handler!({ payload: undefined });
    await new Promise((r) => setTimeout(r, 20));
    handler!({ payload: undefined });
    await new Promise((r) => setTimeout(r, 20));
    const states = emitMock.mock.calls
      .filter((c) => c[0] === "sync-state")
      .map((c) => (c[1] as import("./types").SyncStateEvent).status);
    // 第一次仍 error（streak=1）；第二次 streak=2 → offline。
    expect(states).toContain("error");
    expect(states[states.length - 1]).toBe("offline");
    t!.dispose();
  });
});

describe("D1 逃生门（v5.1.1）：批量删除保险的手动确认放行", () => {
  /** 场景：清单 10 条记录 + 远端 10 对象 + 本地 0 文件 → deleteRemote×10 命中保险。 */
  async function setupMassDeleteRoot(autoSync: boolean) {
    const settings = settingsWith({
      enabled: true,
      autoSync,
      autoSyncIntervalMin: autoSync ? 10 : 0,
      syncOnStart: false,
    });
    const root = "C:/ws/notes";
    const fp = await remoteFingerprint(
      syncConfigPayload(settings.sync),
      fullPrefixOf(settings.sync.prefix, root)
    );
    const m = emptyManifest(root);
    m.lastSyncAt = 1_000;
    m.remoteFingerprint = fp;
    const keys = Array.from({ length: 10 }, (_, i) => `f${i}.md`);
    for (const k of keys) {
      m.files[k] = {
        local: { mtimeMs: 1, size: 1, md5: null },
        remote: { etag: "e", size: 1, lastModified: "2026-01-01T00:00:00Z" },
      };
    }
    await writeManifest(root, m);
    invokeMock.mockImplementation(async (cmd: string): Promise<unknown> => {
      if (cmd === "s3_list") {
        // etag 与清单一致 → 远端 same；本地缺失 → deleteRemote。
        return keys.map((k) => ({ key: `mditor/notes/${k}`, etag: "e", size: 1, lastModified: "2026-01-01T00:00:00Z" }));
      }
      if (cmd === "s3_delete") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    return { settings, root };
  }

  it("手动同步命中保险 → 弹确认框；拒绝 → 中止且零删除", async () => {
    const { settings, root } = await setupMassDeleteRoot(false);
    const t = assembleSyncTrigger({ getSettings: () => settings, getRoots: () => [root] });
    confirmMock.mockResolvedValue(false);
    await t!.syncNow();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0][0])).toContain(root);
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain("s3_delete");
    const events = emitMock.mock.calls
      .filter((c) => c[0] === "sync-state")
      .map((c) => c[1] as import("./types").SyncStateEvent);
    const last = events[events.length - 1];
    expect(last.status).toBe("idle"); // 中止不算根级失败，提示进 notes
    expect((last.notes ?? []).join()).toContain("已中止");
    t!.dispose();
  });

  it("手动同步命中保险 → 确认放行 → 删除全量执行", async () => {
    const { settings, root } = await setupMassDeleteRoot(false);
    const t = assembleSyncTrigger({ getSettings: () => settings, getRoots: () => [root] });
    confirmMock.mockResolvedValue(true);
    await t!.syncNow();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter((c) => c[0] === "s3_delete")).toHaveLength(10);
    t!.dispose();
  });

  it("自动轮次命中保险 → 不弹窗直接中止（防定时器反复打扰）", async () => {
    const { settings, root } = await setupMassDeleteRoot(true);
    const t = assembleSyncTrigger({ getSettings: () => settings, getRoots: () => [root] });
    const intervalCall = intervalSpy.mock.calls.find((c) => c[1] === 10 * 60_000);
    expect(intervalCall).toBeDefined();
    (intervalCall![0] as () => void)(); // 直接驱动定时回调 = 自动轮次（fire-and-forget）
    await new Promise((r) => setTimeout(r, 30)); // 等同步链路完成
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain("s3_delete");
    const events = emitMock.mock.calls
      .filter((c) => c[0] === "sync-state")
      .map((c) => c[1] as import("./types").SyncStateEvent);
    expect((events[events.length - 1].notes ?? []).join()).toContain("已中止");
    t!.dispose();
  });
});
