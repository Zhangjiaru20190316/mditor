// v4.17.2 打包版 CSP 行内样式失效根修的回归守卫（配置钉）。
//
// 背景：Tauri 打包时会对 CSP 做改写，向各指令追加 nonce/hash。按 CSP 规范，
// 源列表一旦出现 nonce，'unsafe-inline' 即被忽略——配置里写好的
// `style-src 'unsafe-inline'` 在打包版里形同虚设。后果分叉：
//   * 块级公式预览（renderToString → DOMPurify → innerHTML）全部垂直定位
//     依赖行内 `style="top:-1.7881em"`，解析时被 CSP 整体丢弃 → 积分/求和
//     上下限塌陷、上划线掉行（用户截图症状）；
//   * 行内公式（katex.render 经 toDOM 直接写 CSSOM）不受 CSP 影响，照常
//     渲染——这正是「行内好好的、块公式全坏」单侧症状的机械成因。
//     CodeMirror 行号错位（global.css「CM 布局钉住」注释）是同一机制此前
//     的历史案例。
// 修复：security.dangerousDisableAssetCspModification 排除 style-src，
// 让 Tauri 不动该指令，'unsafe-inline' 恢复效力；script-src 的 nonce 保护
// 保留。本文件把这两件事钉死，防止配置被无感改回。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as {
  app?: { security?: { csp?: string; dangerousDisableAssetCspModification?: string[] } };
};

describe("tauri.conf.json CSP 配置（打包版公式渲染命门）", () => {
  it("style-src 被排除在 Tauri 的 CSP 改写之外", () => {
    const disabled = conf.app?.security?.dangerousDisableAssetCspModification ?? [];
    expect(disabled).toContain("style-src");
  });

  it("CSP 的 style-src 保留 'unsafe-inline'（行内 style 属性依赖它）", () => {
    const csp = conf.app?.security?.csp ?? "";
    const styleSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("style-src"));
    expect(styleSrc).toBeDefined();
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("script-src 不被放弃改写（Tauri 自身 IPC 脚本的 nonce 保护保留）", () => {
    const disabled = conf.app?.security?.dangerousDisableAssetCspModification ?? [];
    expect(disabled).not.toContain("script-src");
  });
});
