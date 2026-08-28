// 图片字节魔数嗅探（导出内联入口的安全门，v4.6.2 阶段2审计）。
//
// @turbodocx/html-to-docx 内部的 image-size 对 ICNS/JXL/HEIF 存在解析死循环
// （GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq，npm audit high）——文档引用
// 本地恶意图片 + 导出 DOCX 即可挂起应用。在内联入口按魔数放行即可掐断：
// 未知格式保留原引用（浏览器构建的转换器取不到 file:// 引用会静默丢弃，
// 与读取失败的降级路径一致），恶意字节永远到不了 image-size。顺带修正
// 「扩展名说谎」的文件（魔数为准）。

/** 仅放行浏览器可安全渲染的图片格式；未识别返回 null。 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const n = bytes.length;
  if (n >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (n >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF87a / GIF89a
  if (n >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }
  // RIFF….WEBP
  if (n >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (n >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  if (n >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return "image/x-icon";
  }
  // SVG 是文本：'<' 开头（容忍 BOM 与前导空白）。<img> 上下文的 SVG 脚本
  // 不执行，CSP 亦兜底。
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).replace(/^[\s\uFEFF]+/, "");
  if (head.startsWith("<")) return "image/svg+xml";
  return null;
}
