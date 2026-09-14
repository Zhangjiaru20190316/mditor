// 鸿蒙适配层 fs.watch 单测（v4.13 P4）：订阅 fs-watch-event 按 watchId 过滤、
// 逐事件回调、unlisten 退订 + fs.unwatch、recursive 缺省 false。
// 桥客户端整体 vi.mock（内存 request/subscribe）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FsWatchEvent } from "../types";

type EventHandler = (payload: unknown) => void;

const requestMock = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
  if (method === "fs.watch") return { watchId: 7 };
  return null;
});
const handlers = new Map<string, Set<EventHandler>>();
const subscribeMock = vi.fn((event: string, handler: EventHandler) => {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler);
  return () => set?.delete(handler);
});

vi.mock("./bridge-client", () => ({
  bridge: {
    request: (method: string, params?: Record<string, unknown>) => requestMock(method, params),
    subscribe: (event: string, handler: EventHandler) => subscribeMock(event, handler),
  },
}));

import { harmonyAdapter } from "./index";

function emitFsWatch(payload: unknown): void {
  for (const h of handlers.get("fs-watch-event") ?? []) h(payload);
}

beforeEach(() => {
  requestMock.mockClear();
  requestMock.mockImplementation(async (method: string) =>
    method === "fs.watch" ? { watchId: 7 } : null
  );
  subscribeMock.mockClear();
  handlers.clear();
});

describe("harmonyFs.watch（fs-watch-event 订阅/过滤/退订）", () => {
  it("发起 fs.watch 并订阅 fs-watch-event；仅本 watchId 的事件逐个回调", async () => {
    const seen: FsWatchEvent[] = [];
    const un = await harmonyAdapter.fs.watch!(
      "/Docs/ws-1/notes",
      (ev) => seen.push(ev),
      { recursive: false }
    );
    expect(requestMock).toHaveBeenCalledWith("fs.watch", {
      path: "/Docs/ws-1/notes",
      recursive: false,
    });
    expect(subscribeMock).toHaveBeenCalledWith("fs-watch-event", expect.any(Function));

    emitFsWatch({
      watchId: 7,
      events: [
        { type: { kind: "modify" }, paths: ["/Docs/ws-1/notes/a.md"] },
        { type: { kind: "create" }, paths: ["/Docs/ws-1/notes/b.md"] },
      ],
    });
    // 他者 watchId 的事件必须被过滤。
    emitFsWatch({
      watchId: 99,
      events: [{ type: { kind: "modify" }, paths: ["/Docs/ws-1/other/c.md"] }],
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ type: { kind: "modify" }, paths: ["/Docs/ws-1/notes/a.md"] });
    expect(seen[1].type).toEqual({ kind: "create" });

    un();
    expect(requestMock).toHaveBeenCalledWith("fs.unwatch", { watchId: 7 });
    // 退订后不再回调。
    const before = seen.length;
    emitFsWatch({
      watchId: 7,
      events: [{ type: { kind: "any" }, paths: ["/Docs/ws-1/notes/x.md"] }],
    });
    expect(seen).toHaveLength(before);
  });

  it("options 缺省时 recursive=false", async () => {
    const un = await harmonyAdapter.fs.watch!("/AppData", () => undefined);
    expect(requestMock).toHaveBeenCalledWith("fs.watch", { path: "/AppData", recursive: false });
    un();
  });
});
