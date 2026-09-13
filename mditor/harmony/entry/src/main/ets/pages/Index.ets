// Index.ets —— ArkWeb 壳页面（鸿蒙迁移 v4.11）。
//
// 页面从假域名 https://mditor.local/index.html 加载（真机实测 resource://
// rawfile 协议 origin 为 null 且拦截器不生效，ES module 全被 CORS 拒绝）；
// onInterceptRequest 把该域请求映射到 rawfile/web/（见 RawfileResponder）。
// 通过
// javaScriptOnDocumentStart 在页面 JS 运行前注入两样东西：
//   1. window.__MDITOR_HARMONY__ —— 运行时标记（前端 detectRuntime 据此
//      选中 harmony 适配器；不依赖 UA——ArkWeb 的 UA 含 HarmonyOS 标识但
//      不可靠）。
//   2. '__init_port__' 消息监听 —— Bridge.deliverPortToPage() 投递的
//      WebMessagePort 挂到 window.__MDITOR_BRIDGE_PORT__（幂等：已挂则
//      忽略，重载后端口重建会再次投递）。
//
// onConsole 看门狗：前端 console.* 转发到 hilog，无 DevTools 的真机上
// 也能看到前端异常（ErrorBoundary 的错误栈走 console.error）。

import { webview } from '@kit.ArkWeb';
import { Bridge } from '../bridge/Bridge';
import { registerAll, mapperInstance } from '../bridge/Registry';
import { AssetResponder } from '../io/AssetResponder';
import { RawfileResponder } from '../io/RawfileResponder';

// 引导脚本：单引号字符串拼接（ArkTS 对超长模板字符串支持有限）。
const BOOTSTRAP_JS: string = `
window.__MDITOR_HARMONY__ = { platform: 'harmony', shell: 'arkweb' };
(function () {
  function accept(ev) {
    if (ev && ev.data === '__init_port__' && ev.ports && ev.ports.length > 0 &&
        !window.__MDITOR_BRIDGE_PORT__) {
      window.__MDITOR_BRIDGE_PORT__ = ev.ports[0];
    }
  }
  window.addEventListener('message', accept);
})();
`;

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  private bridge: Bridge = new Bridge(this.controller);
  private responder: AssetResponder | null = null;
  private rawResponder: RawfileResponder = new RawfileResponder();

  aboutToAppear(): void {
    // 全量桥方法注册（fs/dialog/store/app 四域；未注册方法返回 UNSUPPORTED）。
    registerAll(this.bridge);
    this.responder = new AssetResponder(mapperInstance()!);
  }

  build() {
    Column() {
      Web({ src: 'https://mditor.local/index.html', controller: this.controller })
        .width('100%')
        .height('100%')
        // 页面 JS 运行前注入运行时标记 + 端口接收器（错过即握手失败）。
        .javaScriptOnDocumentStart([{ script: BOOTSTRAP_JS, scriptRules: ['*'] }])
        .javaScriptAccess(true)
        .domStorageAccess(true) // sessionStorage 自愈快照（lib/session.ts）
        .fileAccess(true)
        .onlineImageAccess(true) // 远程图片 <img> 直连（无 CSP 代理）
        .onControllerAttached(() => {
          this.bridge.setupPort();
        })
        .onPageBegin(() => {
          // 页面（重）加载：端口投递标记复位，onPageEnd 重新投递。
          this.bridge.resetForReload();
        })
        .onPageEnd(() => {
          // 引导脚本已在 document start 就绪，这里投递端口最稳。
          this.bridge.deliverPortToPage();
        })
        // 供源链：mditor-asset:// 本地图片 → mditor.local 域（映射
        // rawfile/web，同源无 CORS）→ 其余放行默认加载。
        .onInterceptRequest((event) => {
          const url = event.request.getRequestUrl();
          const r = this.responder;
          if (r !== null) {
            const asset = r.respond(url);
            if (asset !== null) {
              return asset;
            }
          }
          return this.rawResponder.respond(url);
        })
        // 看门狗：前端 console → hilog（无 DevTools 环境的排障通道）。
        .onConsole((event) => {
          const m = event.message;
          const tag = `[web:${m.getSourceId()}:${m.getLineNumber()}]`;
          if (m.getMessageLevel() === MessageLevel.Error) {
            console.error(`${tag} ${m.getMessage()}`);
          } else {
            console.info(`${tag} ${m.getMessage()}`);
          }
          return false;
        })
        .onErrorReceive((event) => {
          console.error(`[web] 加载失败: ${event.request.getRequestUrl()} → ${event.error.getErrorInfo()}`);
        })
    }
  }
}
