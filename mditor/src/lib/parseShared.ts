// 解析缓存/后台解析管线共享的纯工具（主线程与 worker 都要用，禁止引入
// DOM / Tauri 依赖）。
//
// 内容指纹：解析缓存是内容寻址的（不经路径索引——路径会过期、未命名缓冲
// 没有路径，而指纹天然与内容一一对应），键 = `长度:FNV-1a32`。快扫一遍
// 1MB 文档约 1~3ms，比全文 remark 解析（数百 ms 起）便宜两个数量级；
// 误命中需要同时碰撞长度与 32 位哈希，概率可忽略——且缓存值只是解析结果，
// schema 签名还会二次校验。

/** 内容指纹（长度 + FNV-1a 32 位）。空串也有稳定指纹。 */
export function contentFingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV-1a：h *= 16777619（用移位组合避免精度损失）
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return `${s.length}:${h.toString(36)}`;
}

/** worker 消息协议（主线程 ⇄ parseWorker）。 */
export interface ParseRequest {
  id: number;
  /** UTF-8 编码的原文（ArrayBuffer 走 Transferable，避免结构化克隆拷贝）。 */
  bytes: ArrayBuffer;
  /** 是否包含 LaTeX 语法插件（与 Milkdown 实例的 Latex 特性位一致）。 */
  withMath: boolean;
}

export interface ParseReply {
  id: number;
  ok: boolean;
  /** ok 时：remark 结构化后的 mdast 树（纯 JSON）。 */
  tree?: unknown;
  /** 失败时的错误描述（仅用于诊断，不展示给用户）。 */
  error?: string;
}
