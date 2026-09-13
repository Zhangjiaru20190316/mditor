// Bridge.ets —— ArkTS 侧 JSBridge 分发器（鸿蒙迁移 v4.11）。
//
// 与前端 src/platform/harmony/bridge-client.ts 各持一份协议实现，两端必须
// 一致（改动需同步）：
//   通道：createWebMessagePorts() 的端口 0 留在 ArkTS，端口 1 经
//         controller.postMessage('__init_port__', [port1], '*') 投递给页面；
//         Index.ets 注入的引导脚本把它挂到 window.__MDITOR_BRIDGE_PORT__。
//   请求：{ type:'rpc', id, method, params }        页面 → ArkTS
//   响应：{ type:'rpc', id, ok:true, result } |
//          { type:'rpc', id, ok:false, error:{code,message} }
//   事件：{ type:'event', event, payload }           ArkTS → 页面
//
// 分发规则：所有方法必须显式注册（Map<string, Handler>）；未注册方法统一
// 返回 UNSUPPORTED（前端映射为 UnsupportedError——多窗口等未实施能力由此
// 自然报不支持）。handler 抛错统一转 error 响应，错误码约定：
//   E_UNSUPPORTED / E_PERMISSION / E_IO / E_ARGS / E_INTERNAL / E_AI（AI 域）

import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

/** 桥协议：页面 → ArkTS 的 RPC 请求。 */
interface RpcRequest {
  type: string;
  id: number;
  method: string;
  params: Record<string, Object>;
}

/** 桥协议：错误载荷。 */
interface RpcError {
  code: string;
  message: string;
}

/** 桥协议：成功响应。 */
interface RpcResponseOk {
  type: string;
  id: number;
  ok: boolean;
  result: Object | null;
}

/** 桥协议：失败响应。 */
interface RpcResponseErr {
  type: string;
  id: number;
  ok: boolean;
  error: RpcError;
}

/** 桥协议：ArkTS → 页面事件。 */
interface BridgeEventMsg {
  type: string;
  event: string;
  payload: Object;
}

/** 已注册方法的处理函数形态。返回值 JSON 化后作为 result 回传。 */
export type MethodHandler = (params: Record<string, Object>) => Promise<Object | null>;

/** 桥错误（handler 内 throw 即可，code 透传给前端）。 */
export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class Bridge {
  private controller: webview.WebviewController;
  /** ArkTS 持有的端口 0（接收页面请求、发送响应与事件）。 */
  private nativePort: webview.WebMessagePort | null = null;
  /** 待投递给页面的端口 1（setupPort 后缓存，onPageEnd 投递一次）。 */
  private webPort: webview.WebMessagePort | null = null;
  private portDelivered: boolean = false;
  private handlers: Map<string, MethodHandler> = new Map();
  /** 页面重载清理回调（resetForReload 触发；AiBridge/WatchManager 注册）。 */
  private reloadListeners: Array<() => void> = [];

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  /** 注册一个桥方法（幂等：同名覆盖）。 */
  register(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * 创建消息端口对（onControllerAttached 时调用一次）。
   * 端口 0 留在 ArkTS 并接上接收回调；端口 1 缓存待投递。
   */
  setupPort(): void {
    if (this.nativePort !== null) {
      return;
    }
    try {
      const ports: Array<webview.WebMessagePort> = this.controller.createWebMessagePorts();
      this.nativePort = ports[0];
      this.webPort = ports[1];
      this.nativePort.onMessageEvent((msg: webview.WebMessage) => {
        // 协议全程 JSON 字符串（中文路径天然安全）；ArrayBuffer 忽略。
        if (typeof msg === 'string') {
          this.dispatch(msg);
        }
      });
      hilog.info(0x0D01, 'mditor', 'Bridge: 消息端口已建立');
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(0x0D01, 'mditor', 'Bridge: createWebMessagePorts 失败 %{public}d %{public}s',
        e.code, e.message);
    }
  }

  /** 把端口 1 投递给页面（onPageEnd 调用；引导脚本已就绪，幂等）。 */
  deliverPortToPage(): void {
    if (this.portDelivered || this.webPort === null) {
      return;
    }
    try {
      this.controller.postMessage('__init_port__', [this.webPort], '*');
      this.portDelivered = true;
      hilog.info(0x0D01, 'mditor', 'Bridge: 端口已投递给页面');
    } catch (err) {
      const e = err as BusinessError;
      // 页面导航竞态下可能失败——不置 delivered，下个 onPageEnd 重试。
      hilog.warn(0x0D01, 'mditor', 'Bridge: 端口投递失败 %{public}d %{public}s', e.code, e.message);
    }
  }

/** 页面重载后端口需重建（onPageBegin 调用，重置投递标记）。 */
  resetForReload(): void {
    this.portDelivered = false;
    // 页面 JS 上下文已销毁：ArkTS 侧的推送上下文（AI 流泵 / 文件监听等）
    // 同步清理（消费方订阅随页面消失，前端冷启动后自行重挂）。
    const fns = this.reloadListeners.slice();
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // 单个监听失败不拖垮其余清理
      }
    }
  }

  /** 注册页面重载清理回调（AiBridge 停流 / WatchManager 摘监听等）。 */
  onReload(fn: () => void): void {
    this.reloadListeners.push(fn);
  }

  private dispatch(raw: string): void {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw) as RpcRequest;
    } catch {
      hilog.warn(0x0D01, 'mditor', 'Bridge: 非 JSON 消息（丢弃）');
      return;
    }
    if (req === null || req.type !== 'rpc' || typeof req.id !== 'number') {
      return;
    }
    const handler: MethodHandler | undefined = this.handlers.get(req.method);
    if (handler === undefined) {
      this.sendError(req.id, 'UNSUPPORTED', `未注册的桥方法：${req.method}`);
      return;
    }
    const params: Record<string, Object> = req.params === undefined || req.params === null
      ? ({ } as Record<string, Object>)
      : req.params;
    handler(params).then((result: Object | null) => {
      this.sendOk(req.id, result);
    }).catch((err: Object) => {
      if (err instanceof BridgeError) {
        this.sendError(req.id, err.code, err.message);
        return;
      }
      const e = err as BusinessError;
      const code: string = typeof e.code === 'number' ? `E_IO_${e.code}` : 'E_INTERNAL';
      this.sendError(req.id, code, e.message ?? String(err));
    });
  }

  /** 主动向页面广播事件（settings-changed / window-close-requested…）。 */
  sendEvent(event: string, payload: Object): void {
    const msg: BridgeEventMsg = { type: 'event', event, payload: payload };
    this.post(JSON.stringify(msg));
  }

  private sendOk(id: number, result: Object | null): void {
    const resp: RpcResponseOk = { type: 'rpc', id: id, ok: true, result: result };
    this.post(JSON.stringify(resp));
  }

  private sendError(id: number, code: string, message: string): void {
    const err: RpcError = { code: code, message: message };
    const resp: RpcResponseErr = { type: 'rpc', id: id, ok: false, error: err };
    this.post(JSON.stringify(resp));
  }

  private post(text: string): void {
    if (this.nativePort === null) {
      return;
    }
    try {
      this.nativePort.postMessageEvent(text);
    } catch (err) {
      const e = err as BusinessError;
      hilog.error(0x0D01, 'mditor', 'Bridge: postMessageEvent 失败 %{public}d', e.code);
    }
  }
}
