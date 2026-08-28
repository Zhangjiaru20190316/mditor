import { describe, expect, it } from "vitest";
import { sniffImageMime } from "./imageSniff";

const B = (...bs: number[]) => new Uint8Array(bs);
const pad = (u: Uint8Array, n = 32) => new Uint8Array([...u, ...new Array(n).fill(0)]);

describe("sniffImageMime（导出内联魔数门）", () => {
  it("放行 PNG / JPEG / GIF / WebP / BMP / ICO", () => {
    expect(sniffImageMime(B(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageMime(B(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(B(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))).toBe("image/gif");
    expect(sniffImageMime(B(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(sniffImageMime(B(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
    expect(sniffImageMime(B(0x42, 0x4d))).toBe("image/bmp");
    expect(sniffImageMime(B(0, 0, 1, 0))).toBe("image/x-icon");
  });

  it("放行 SVG（文本 '<' 开头，容忍 BOM 与前导空白）", () => {
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"/>`);
    expect(sniffImageMime(svg)).toBe("image/svg+xml");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("\n<svg/>")]);
    expect(sniffImageMime(withBom)).toBe("image/svg+xml");
  });

  it("拒绝 image-size 死循环格式：ICNS / JXL / HEIC（安全回归网）", () => {
    // ICNS: 'icns' 魔数
    expect(sniffImageMime(B(0x69, 0x63, 0x6e, 0x73))).toBeNull();
    // JXL: 0x0000000C 'JXL '
    expect(sniffImageMime(B(0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20))).toBeNull();
    // HEIC: '....ftypheic'
    expect(sniffImageMime(B(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63))).toBeNull();
  });

  it("拒绝随机字节 / 空输入 / 可执行文件", () => {
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    expect(sniffImageMime(pad(B(0x4d, 0x5a)))).toBeNull(); // PE 头
    expect(sniffImageMime(new TextEncoder().encode("#!/bin/sh\nid"))).toBeNull();
    expect(sniffImageMime(pad(B(0x1f, 0x8b)))).toBeNull(); // gzip
  });
});
