// 应用版本号的统一取用（v4.12.2）。
//
// 背景：应用长期没有任何可见版本号，「装的是不是新版」全靠猜——取证盲区。
// 来源两级：
//   1. 运行时 adapter 的 app.version()（Tauri 下即 tauri.conf.json 的
//      version，随安装包分发）；
//   2. 回退：构建期把 src-tauri/tauri.conf.json 以 ?raw 内联进 bundle 解析
//      出 version（浏览器适配层 version() 不可用时仍有读数）。
// 消费方：设置「关于」分区、帮助→关于 弹窗（AboutModal）。

import { getAdapter } from "../platform";
import tauriConfRaw from "../../src-tauri/tauri.conf.json?raw";

/** 构建期内联回退版本（解析失败给空串，调用方显示 "—"）。 */
export function buildTimeVersion(): string {
  try {
    const v = (JSON.parse(tauriConfRaw) as { version?: string }).version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** 取当前应用版本：运行时适配层优先，异常/空值回退构建期版本。 */
export async function fetchAppVersion(): Promise<string> {
  try {
    const v = await getAdapter().app.version();
    if (v) return v;
  } catch {
    /* 适配层不可用（浏览器 dev 等）→ 回退 */
  }
  return buildTimeVersion();
}
