// Tauri 原生弹窗封装：统一替换 webview 的 window.alert / window.confirm
// （WebView2 的原生弹窗样式不可控、与桌面应用观感割裂）。权限由 capabilities
// 中的 dialog:allow-message / dialog:allow-confirm 授权。
import { message, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";

const APP_TITLE = "Mditor";

/** 提示框（替代 window.alert）。kind 影响系统图标：info / warning / error。 */
export async function showAlert(
  content: string,
  title = APP_TITLE,
  kind: "info" | "warning" | "error" = "info"
): Promise<void> {
  await message(content, { title, kind });
}

/** 确认框（替代 window.confirm），按钮文案统一「确定 / 取消」。 */
export function confirmDialog(content: string, title = APP_TITLE): Promise<boolean> {
  return tauriConfirm(content, {
    title,
    kind: "warning",
    okLabel: "确定",
    cancelLabel: "取消",
  });
}
