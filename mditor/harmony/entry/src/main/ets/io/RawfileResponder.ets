// RawfileResponder.ets —— rawfile 静态资源供源（鸿蒙迁移 v4.11.1 白屏根修）。
//
// 根因（真机日志实锤）：ArkWeb 的 resource://rawfile 方案 origin 为 null，
// 不在 CORS 允许的协议列表内——vite 产物是 ES module（type=module，CORS
// 模式请求），全部被 "blocked by CORS policy" 拒绝，JS 永不执行，页面停在
// index.html 的静态开屏页。
//
// 解法（二次修正，真机验证）：onInterceptRequest 拦不到 resource:// 协议
// （内核内部处理）。因此页面改从假域名 https://mditor.local/index.html
// 加载，本类拦截该域全部请求、从 rawfile/web/ 读字节回填——页面与资源
// 同源，CORS 检查天然不触发。resource:// 前缀保留兼容（旧路径放行）。

import { common } from '@kit.AbilityKit';
import { resourceManager } from '@kit.LocalizationKit';
import { HostContext } from '../bridge/HostContext';

const HOST_PREFIX = 'https://mditor.local/';
const RAW_PREFIX = 'resource://rawfile/';

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

export class RawfileResponder {
  /** resourceManager 延迟取（HostContext 在 Ability onCreate 已挂）。 */
  private resourceManager: resourceManager.ResourceManager | null = null;

  private resManager(): resourceManager.ResourceManager | null {
    if (this.resourceManager !== null) {
      return this.resourceManager;
    }
    const ability = HostContext.ability;
    if (ability !== null && ability.context !== null) {
      const ctx = ability.context as common.UIAbilityContext;
      this.resourceManager = ctx.resourceManager;
      return this.resourceManager;
    }
    return null;
  }

  /** 拦截回调：https://mditor.local/<path> → rawfile/web/<path>；
   *  其它前缀返回 null 放行（如 mditor-asset:// 由 AssetResponder 先行）。 */
  respond(url: string): WebResourceResponse | null {
    let rawPath: string;
    if (url.startsWith(HOST_PREFIX)) {
      rawPath = `web/${url.slice(HOST_PREFIX.length)}`;
    } else if (url.startsWith(RAW_PREFIX)) {
      rawPath = url.slice(RAW_PREFIX.length);
    } else {
      return null;
    }
    // 去掉 query / fragment（vite 产物无，保险处理）。
    const cut = rawPath.search(/[?#]/);
    if (cut >= 0) {
      rawPath = rawPath.slice(0, cut);
    }
    if (rawPath.length === 0 || rawPath.endsWith('/')) {
      rawPath += 'index.html';
    }
    const rm = this.resManager();
    if (rm === null) {
      return this.notFound(rawPath);
    }
    try {
      const bytes: Uint8Array = rm.getRawFileContentSync(rawPath);
      // 拷出独立 ArrayBuffer（避免底层大 buffer 的 offset 视图）。
      const data = bytes.slice().buffer as ArrayBuffer;
      const resp = new WebResourceResponse();
      resp.setResponseMimeType(this.mimeOf(rawPath));
      resp.setResponseEncoding('utf-8');
      resp.setResponseData(data);
      resp.setResponseCode(200);
      resp.setReasonMessage('OK');
      // 关键：module 脚本按 CORS 模式加载，页面 origin 为 null——
      // 响应必须带 ACAO 才能通过校验。
      const cors: Header = { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' };
      resp.setResponseHeader([cors]);
      return resp;
    } catch {
      return this.notFound(rawPath);
    }
  }

  private notFound(path: string): WebResourceResponse {
    const resp = new WebResourceResponse();
    resp.setResponseMimeType('text/plain');
    resp.setResponseData(`rawfile not found: ${path}`);
    resp.setResponseCode(404);
    resp.setReasonMessage('Not Found');
    return resp;
  }

  private mimeOf(path: string): string {
    const dot = path.lastIndexOf('.');
    if (dot < 0) {
      return 'application/octet-stream';
    }
    const ext = path.slice(dot).toLowerCase();
    const m = MIME_BY_EXT[ext];
    return m !== undefined ? m : 'application/octet-stream';
  }
}
