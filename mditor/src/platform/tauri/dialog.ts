// Tauri 平台的弹窗域实现（鸿蒙迁移 v4.11）：plugin-dialog 的语义化包装。
// pickOpenFile / pickSaveFile / pickDirectory 与旧 open/save 调用一一对应。

import { open, save, message, confirm } from "@tauri-apps/plugin-dialog";
import type {
  ConfirmDialogOptions,
  FileFilter,
  MessageDialogOptions,
  PlatformDialog,
} from "../types";

export const tauriDialog: PlatformDialog = {
  async pickOpenFile(filters?: FileFilter[]): Promise<string | null> {
    const p = await open({ multiple: false, filters });
    // multiple:false 时返回 string | null（string[] 只是类型系统的保守分支）
    return typeof p === "string" ? p : null;
  },
  pickSaveFile: (defaultName?: string, filters?: FileFilter[]) =>
    save({ defaultPath: defaultName, filters }),
  async pickDirectory(): Promise<string | null> {
    const p = await open({ directory: true, multiple: false });
    return typeof p === "string" ? p : null;
  },
  message: async (content, options?: MessageDialogOptions) => {
    await message(content, options);
  },
  confirm: (content, options?: ConfirmDialogOptions) =>
    confirm(content, options),
};
