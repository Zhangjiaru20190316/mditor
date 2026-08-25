// Tauri 原生弹窗封装：统一替换 webview 的 window.alert / window.confirm
// （WebView2 的原生弹窗样式不可控、与桌面应用观感割裂）。权限由 capabilities
// 中的 dialog:allow-message / dialog:allow-confirm 授权。
import { message, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { tracedIo } from "./ipcTrace";

const APP_TITLE = "Mditor";

/** 提示框（替代 window.alert）。kind 影响系统图标：info / warning / error。 */
export async function showAlert(
  content: string,
  title = APP_TITLE,
  kind: "info" | "warning" | "error" = "info"
): Promise<void> {
  // 对话框不设慢阈值：时长=用户思考时间，不是异常（只记失败）。
  await tracedIo("ipc:dialog", `showAlert:${title}`, () =>
    message(content, { title, kind })
  , { slowMs: Infinity });
}

/** 确认框（替代 window.confirm），按钮文案统一「确定 / 取消」。 */
export function confirmDialog(content: string, title = APP_TITLE): Promise<boolean> {
  return tracedIo("ipc:dialog", `confirm:${title}`, () =>
    tauriConfirm(content, {
      title,
      kind: "warning",
      okLabel: "确定",
      cancelLabel: "取消",
    })
  , { slowMs: Infinity });
}

/** 自定义按钮文案的二选一确认（取消/关闭视同否）。 */
export function choiceDialog(
  content: string,
  okLabel: string,
  cancelLabel: string,
  title = APP_TITLE
): Promise<boolean> {
  return tracedIo("ipc:dialog", `choice:${title}:${okLabel}`, () =>
    tauriConfirm(content, {
      title,
      kind: "info",
      okLabel,
      cancelLabel,
    })
  , { slowMs: Infinity });
}
