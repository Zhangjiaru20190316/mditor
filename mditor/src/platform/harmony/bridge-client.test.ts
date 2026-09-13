// 桥客户端单测（鸿蒙迁移 v4.11 阶段 3）——用内存 mock 端口模拟 ArkTS 侧
// 行为，锚定两端协议（与 harmony/entry/src/main/ets/bridge/Bridge.ets 对表）。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BridgeClient, type BridgePort } from "./bridge-client";
import { UnsupportedError } from "../errors";

/** 可注入 onmessage 的端口（客户端 attach 时赋值，测试侧直调）。 */
type InjectablePort = BridgePort & {
  onmessage: ((ev: { data: unknown }) => void) | null;
};

/** 内存端口对：模拟 createWebMessagePorts 的两端。 */
class MockPortPair {
  readonly webSide: InjectablePort;
  readonly nativeSide: InjectablePort;

  constructor() {
    this.webSide = {
      postMessage: () => undefined, // web→native 由测试用 spyHandler 接管
      close: () => undefined,
      onmessage: null,
    };
    this.nativeSide = {
      // ArkTS → 前端：直接投给前端 onmessage（客户端 attach 后非空）。
      postMessage: (data: string) => {
        this.webSide.onmessage?.({ data });
      },
      close: () => undefined,
      onmessage: null,
    };
  }

  /** 让 webSide.postMessage 转发到 nativeSide.onmessage（模拟对端接收）。 */
  wireWebToNative(): void {
    const pair = this;
    this.webSide.postMessage = (data: string) => {
      pair.nativeSide.onmessage?.({ data });
    };
  }
}

describe("BridgeClient（JSON-RPC over WebMessagePort）", () => {
  let pair: MockPortPair;
  let nativeReceived: string[];
  let client: BridgeClient;

  beforeEach(() => {
    pair = new MockPortPair();
    nativeReceived = [];
    // ArkTS 侧：记录前端请求，测试手动回响应。
    pair.nativeSide.onmessage = (ev) => {
      nativeReceived.push(String(ev.data));
    };
    pair.wireWebToNative();
    client = new BridgeClient({ getPort: () => pair.webSide, timeoutMs: 1000 });
  });

  afterEach(() => {
    client.dispose();
  });

  it("request 发出 {type:'rpc',id,method,params} 形态的 JSON", async () => {
    const p = client.request<{ content: string }>("fs.readTextFile", { path: "/Docs/ws-1/a.md" });
    await vi.waitFor(() => expect(nativeReceived.length).toBe(1));
    const msg = JSON.parse(nativeReceived[0]);
    expect(msg.type).toBe("rpc");
    expect(msg.method).toBe("fs.readTextFile");
    expect(msg.params).toEqual({ path: "/Docs/ws-1/a.md" });
    expect(typeof msg.id).toBe("number");
    // 按协议回成功响应。
    pair.nativeSide.postMessage(
      JSON.stringify({ type: "rpc", id: msg.id, ok: true, result: { content: "# hi" } })
    );
    await expect(p).resolves.toEqual({ content: "# hi" });
  });

  it("错误响应映射 UnsupportedError（UNSUPPORTED 码）", async () => {
    const p = client.request("ai_chat", {});
    await vi.waitFor(() => expect(nativeReceived.length).toBe(1));
    const msg = JSON.parse(nativeReceived[0]);
    pair.nativeSide.postMessage(
      JSON.stringify({
        type: "rpc",
        id: msg.id,
        ok: false,
        error: { code: "UNSUPPORTED", message: "未注册的桥方法：ai_chat" },
      })
    );
    await expect(p).rejects.toBeInstanceOf(UnsupportedError);
    // 桥侧 UNSUPPORTED 的 message 原样透传（更有信息量）；AI 面板的
    // 「鸿蒙版暂不支持 AI」文案由 ai.ts 的能力守卫给出，不经此路径。
    await expect(p).rejects.toThrow(/未注册的桥方法/);
  });

  it("E_PERMISSION 错误保留 code（前端引导重选工作区）", async () => {
    const p = client.request("fs.readDir", { path: "/Docs/ws-1" });
    await vi.waitFor(() => expect(nativeReceived.length).toBe(1));
    const msg = JSON.parse(nativeReceived[0]);
    pair.nativeSide.postMessage(
      JSON.stringify({
        type: "rpc",
        id: msg.id,
        ok: false,
        error: { code: "E_PERMISSION", message: "无权访问" },
      })
    );
    const err = await p.catch((e) => e);
    expect((err as Error & { code?: string }).code).toBe("E_PERMISSION");
  });

  it("超时拒绝（构造传入的 timeoutMs 生效）", async () => {
    const p = client.request("fs.stat", { path: "/x" });
    await vi.waitFor(() => expect(nativeReceived.length).toBe(1));
    await expect(p).rejects.toThrow(/超时/);
  });

  it("subscribe 收到 {type:'event'} 消息的 payload；退订后不再收", async () => {
    const seen: unknown[] = [];
    const un = client.subscribe("settings-changed", (payload) => seen.push(payload));
    // subscribe 的懒连接是异步的：等端口接上再投递。
    await vi.waitFor(() => expect(pair.webSide.onmessage).not.toBeNull());
    pair.nativeSide.postMessage(
      JSON.stringify({ type: "event", event: "settings-changed", payload: { theme: "dark" } })
    );
    expect(seen).toEqual([{ theme: "dark" }]);
    un();
    pair.nativeSide.postMessage(
      JSON.stringify({ type: "event", event: "settings-changed", payload: { theme: "light" } })
    );
    expect(seen).toHaveLength(1);
  });

  it("协议外噪声消息被丢弃，不抛错", () => {
    expect(() => {
      client.handleMessage("not-json{{");
      client.handleMessage({ type: "unknown" });
      client.handleMessage({ type: "rpc", id: 999, ok: true, result: null }); // 无等待者
    }).not.toThrow();
  });

  it("id 不匹配的响应被忽略（过期请求不串扰）", async () => {
    const p = client.request("fs.exists", { path: "/a" });
    await vi.waitFor(() => expect(nativeReceived.length).toBe(1));
    pair.nativeSide.postMessage(
      JSON.stringify({ type: "rpc", id: 987654, ok: false, error: { code: "E_IO", message: "x" } })
    );
    const msg = JSON.parse(nativeReceived[0]);
    pair.nativeSide.postMessage(JSON.stringify({ type: "rpc", id: msg.id, ok: true, result: true }));
    await expect(p).resolves.toBe(true);
  });

  it("端口未就绪时轮询等待（冷启动竞态补救）", async () => {
    let port: BridgePort | null = null;
    const late = new BridgeClient({ getPort: () => port, timeoutMs: 500 });
    pair.nativeSide.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "rpc") {
        pair.nativeSide.postMessage(
          JSON.stringify({ type: "rpc", id: msg.id, ok: true, result: "4.10.0" })
        );
      }
    };
    const p = late.request("app.version");
    setTimeout(() => {
      port = pair.webSide;
    }, 150);
    await expect(p).resolves.toBe("4.10.0");
    late.dispose();
  });

  it("并发请求各自匹配响应（id 路由）", async () => {
    const p1 = client.request("fs.exists", { path: "/a" });
    const p2 = client.request("fs.exists", { path: "/b" });
    await vi.waitFor(() => expect(nativeReceived.length).toBe(2));
    const [m1, m2] = nativeReceived.map((s) => JSON.parse(s));
    expect(m1.id).not.toBe(m2.id);
    pair.nativeSide.postMessage(JSON.stringify({ type: "rpc", id: m2.id, ok: true, result: false }));
    pair.nativeSide.postMessage(JSON.stringify({ type: "rpc", id: m1.id, ok: true, result: true }));
    await expect(p2).resolves.toBe(false);
    await expect(p1).resolves.toBe(true);
  });
});
