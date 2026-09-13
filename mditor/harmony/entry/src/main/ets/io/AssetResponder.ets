// AssetResponder.ets —— mditor-asset:// 图片供源（鸿蒙迁移 v4.11）。
//
// 前端 imageManager.resolveImgSrc 在鸿蒙下把虚拟路径编成
// mditor-asset://<encodeURIComponent(虚拟路径)>（platform/harmony/index.ts
// 的 convertFileSrc）。Web.onInterceptRequest 拦截该 scheme，经 UriMapper
// 解析后从文件系统读字节回填响应——镜像桌面版 asset:// 的角色。
//
// 同步实现（onInterceptRequest 回调无异步余地）；读不到一律 404（图片
// 破图优于阻塞渲染）。

import { webview } from '@kit.ArkWeb';
import fs from '@ohos.file.fs';
import { UriMapper } from './UriMapper';

/** WebResourceResponse 为全局声明类（component/web.d.ts），非 webview 命名空间。 */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

export class AssetResponder {
  private readonly mapper: UriMapper;

  constructor(mapper: UriMapper) {
    this.mapper = mapper;
  }

  /** 拦截回调：非 mditor-asset:// 返回 null（放行默认加载）。 */
  respond(url: string): WebResourceResponse | null {
    if (!url.startsWith('mditor-asset://')) {
      return null;
    }
    const encoded = url.slice('mditor-asset://'.length);
    let virtualPath = '';
    try {
      virtualPath = decodeURIComponent(encoded);
    } catch {
      return this.notFound();
    }
    const r = this.mapper.tryResolve(virtualPath);
    if (r === null) {
      return this.notFound();
    }
    const target = r.kind === 'sandbox' ? r.sandboxPath : r.uri;
    try {
      const file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      try {
        const st = fs.statSync(file.fd);
        const buf = new ArrayBuffer(st.size);
        let total = 0;
        while (total < st.size) {
          const n = fs.readSync(file.fd, buf, { offset: total });
          if (n <= 0) {
            break;
          }
          total += n;
        }
        const data = buf.slice(0, total);
        const resp = new WebResourceResponse();
        resp.setResponseMimeType(this.mimeOf(virtualPath));
        resp.setResponseData(data);
        resp.setResponseEncoding('binary');
        resp.setResponseCode(200);
        resp.setReasonMessage('OK');
        return resp;
      } finally {
        fs.closeSync(file);
      }
    } catch {
      return this.notFound();
    }
  }

  private notFound(): WebResourceResponse {
    const resp = new WebResourceResponse();
    resp.setResponseMimeType('text/plain');
    resp.setResponseData('mditor-asset: not found');
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
