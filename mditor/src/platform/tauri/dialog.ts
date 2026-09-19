// Tauri 平台的弹窗域实现（鸿蒙迁移 v4.11）：plugin-dialog 的语义化包装。
// pickOpenFile / pickSaveFile / pickDirectory 与旧 open/save 调用一一对应。

import { open, save, message, confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConfirmDialogOptions,
  FileFilter,
  MessageDialogOptions,
  PlatformDialog,
} from "../types";

// S1：用户在对话框里亲自选中的路径 = 明确的授权意图。选完立即加入 fs/asset
// 作用域（文件单点；目录递归），fs 静态 scope（$APPDATA/$DOCUMENT）之外的一切
// 路径都经此放行。授权失败不阻塞选择结果——后续 fs 调用会给出明确错误。
function grant(path: string, recursive: boolean): void {
  void invoke("grant_fs_scope", { paths: [path], recursive }).catch(() => undefined);
}

export const tauriDialog: PlatformDialog = {
  async pickOpenFile(filters?: FileFilter[]): Promise<string | null> {
    const p = await open({ multiple: false, filters });
    // multiple:false 时返回 string | null（string[] 只是类型系统的保守分支）
    if (typeof p === "string") grant(p, false);
    return typeof p === "string" ? p : null;
  },
  pickSaveFile: (defaultName?: string, filters?: FileFilter[]) =>
    save({ defaultPath: defaultName, filters }).then((p) => {
      if (typeof p === "string") grant(p, false);
      return p;
    }),
  async pickDirectory(): Promise<string | null> {
    const p = await open({ directory: true, multiple: false });
    if (typeof p === "string") grant(p, true);
    return typeof p === "string" ? p : null;
  },
  message: async (content, options?: MessageDialogOptions) => {
    await message(content, options);
  },
  confirm: (content, options?: ConfirmDialogOptions) =>
    confirm(content, options),
};
