// ArkWeb 桥客户端（鸿蒙迁移 v4.11）——与 harmony/entry/src/main/ets/bridge/
// Bridge.ets 各持一份协议实现，两端必须一致：
//
//   通道：webview.Webview.createWebMessagePorts() 的端口 1，由 ArkTS 在页面
//   JS 运行前挂到 window.__MDITOR_BRIDGE_PORT__（见 Index.ets 的引导注入）。
//   请求：{ type:'rpc', id, method, params }        前端 → ArkTS
//   响应：{ type:'rpc', id, ok:true, result } | { type:'rpc', id, ok:false,
//          error:{code,message} }                    ArkTS → 前端
//   事件：{ type:'event', event, payload }           ArkTS → 前端
//   method 命名域：fs.* / dialog.* / store.* / app.* / ai.* / s3_*（与
//   platform/types 及各桥实现域一一对应）。未注册方法返回 UNSUPPORTED。
//
// 握手幂等：注入代码只负责把端口挂到全局；本客户端在首个请求/订阅时才
// 连接（懒连接），错过 document start 也能补救（轮询等端口出现）。
// 纯逻辑、端口可注入——内存 mock 端口即可单测。

import { bridgeErrorToError } from "../errors";

/** 页面侧拿到的端口形状（ArkWeb WebMessagePort 的能力子集）。 */
export interface BridgePort {
  postMessage(data: string): void;
  close?(): void;
}

/** 端口提供者：ArkTS 引导注入的全局（window.__MDITOR_BRIDGE_PORT__）。
 *  可注入以便测试。 */
export type PortProvider = () => BridgePort | null | undefined;

/** 从 window 上找桥端口（由 Index.ets 的 javaScriptOnDocumentStart 注入）。 */
function defaultPortProvider(): BridgePort | null | undefined {
  if (typeof window === "undefined") return null;
  return (window as { __MDITOR_BRIDGE_PORT__?: BridgePort })
    .__MDITOR_BRIDGE_PORT__;
}

interface RpcRequest {
  type: "rpc";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type RpcResponse =
  | { type: "rpc"; id: number; ok: true; result: unknown }
  | { type: "rpc"; id: number; ok: false; error: { code: string; message: string } };

interface BridgeEventMessage {
  type: "event";
  event: string;
  payload?: unknown;
}

type Incoming = RpcResponse | BridgeEventMessage;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (payload: unknown) => void;

/** 桥客户端：promise 化 RPC + 事件订阅。 */
export class BridgeClient {
  private readonly getPort: PortProvider;
  private readonly timeoutMs: number;
  private port: BridgePort | null = null;
  private portPromise: Promise<BridgePort> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();

  constructor(options: { getPort?: PortProvider; timeoutMs?: number } = {}) {
    this.getPort = options.getPort ?? defaultPortProvider;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** 端口是否已就绪（立即返回，不轮询）。 */
  isPortAvailable(): boolean {
    return this.getPort() != null;
  }

  /** 等端口出现（ArkTS 在 document start 注入；冷启动竞态下最多等 10s）。 */
  async waitForPort(deadlineMs = 10_000): Promise<BridgePort> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const p = this.getPort();
      if (p) return p;
      if (Date.now() >= deadline) {
        throw new Error("鸿蒙桥端口未就绪（window.__MDITOR_BRIDGE_PORT__ 缺失）");
      }
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }

  /** 懒连接（单飞）：并发请求共享一次握手；失败不缓存，下次重试。 */
  private ensurePort(): Promise<BridgePort> {
    if (this.port) return Promise.resolve(this.port);
    if (!this.portPromise) {
      this.portPromise = this.waitForPort()
        .then((p) => {
          this.attach(p);
          return p;
        });
      this.portPromise.catch(() => {
        this.portPromise = null;
      });
    }
    return this.portPromise;
  }

  /** 绑定端口并接上消息回调。重复调用是 no-op（幂等握手）。 */
  private attach(port: BridgePort): void {
    if (this.port) return;
    this.port = port;
    const injectable = port as BridgePort & {
      onmessage?: ((ev: { data: unknown }) => void) | null;
    };
    // 标准 MessagePort 语义：onmessage 收 ArkTS 侧 postMessage 的数据。
    injectable.onmessage = (ev) => this.handleMessage(ev.data);
  }

  /** 处理一条来自 ArkTS 的消息（JSON 字符串或已解析对象）。测试亦可直调。 */
  handleMessage(raw: unknown): void {
    let msg: Incoming;
    try {
      msg = (typeof raw === "string" ? JSON.parse(raw) : raw) as Incoming;
    } catch {
      return; // 协议外噪声 — 丢弃
    }
    if (msg?.type === "rpc") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(bridgeErrorToError(msg.error));
      return;
    }
    if (msg?.type === "event") {
      const set = this.eventHandlers.get(msg.event);
      if (set) for (const h of [...set]) h(msg.payload);
    }
  }

  /** 发起一次 RPC。超时（默认 30s）拒绝；错误带桥侧 code。 */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      void this.ensurePort()
        .then((port) => {
          const id = this.nextId++;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`桥请求超时：${method}`));
          }, this.timeoutMs);
          this.pending.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
            timer,
          });
          const req: RpcRequest = { type: "rpc", id, method, params };
          port.postMessage(JSON.stringify(req));
        })
        .catch(reject);
    });
  }

  /** 订阅桥事件（settings-changed / window-close-requested…）。
   *  订阅即触发懒连接——纯事件消费者（无 rpc）也要接上端口。 */
  subscribe(event: string, handler: EventHandler): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
    void this.ensurePort().catch(() => undefined);
    return () => {
      set?.delete(handler);
    };
  }

  /** 主动断开（测试清理用）。 */
  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("桥客户端已销毁"));
    }
    this.pending.clear();
    this.eventHandlers.clear();
    this.port?.close?.();
    this.port = null;
    this.portPromise = null;
  }
}

/** 进程级单例（业务代码从 platform/harmony/index.ts 拿适配器，不直接用它）。 */
export const bridge = new BridgeClient();
