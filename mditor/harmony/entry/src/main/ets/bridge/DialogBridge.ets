// DialogBridge.ets —— dialog.* 桥实现（鸿蒙迁移 v4.11）。
//
// 文件选择：DocumentViewPicker（PC 全屏选择器）；选中后立即挂载 UriMapper
// token 并持久化 URI 权限（fileShare.persistPermission，Picker 临时授权
// 重启即失效），前端拿到的永远是虚拟路径。
// 弹窗：AlertDialog 经主窗口 UIContext 展示（样式与系统一致）。

import { picker } from '@kit.CoreFileKit';
import { fileShare } from '@kit.CoreFileKit';
import { window } from '@kit.ArkUI';
import { UIContext } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BridgeError } from './Bridge';
import { HostContext } from './HostContext';
import { UriMapper } from '../io/UriMapper';

/** 桥协议：前端传来的过滤器组。 */
interface FilterGroup {
  name: string;
  extensions: string[];
}

/** 桥协议：message/confirm 的选项。 */
interface DialogOptions {
  title?: string;
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
}

export class DialogBridge {
  private readonly mapper: UriMapper;

  constructor(mapper: UriMapper) {
    this.mapper = mapper;
  }

  /** 选一个文件：挂载其父目录为 token（相对图片引用天然可解析）。 */
  async pickOpenFile(params: Record<string, Object>): Promise<Object | null> {
    const docPicker = new picker.DocumentViewPicker();
    const option = new picker.DocumentSelectOptions();
    option.maxSelectNumber = 1;
    const suffixes = this.suffixesOf(params);
    if (suffixes.length > 0) {
      option.fileSuffixFilters = suffixes;
    }
    const uris = await this.guard(async () => {
      return docPicker.select(option);
    }, '打开文件选择器');
    if (uris.length === 0) {
      return null; // 用户取消
    }
    return this.mountFileUri(uris[0]);
  }

  /** 选保存目标：默认文件名；返回新建文件的虚拟路径。 */
  async pickSaveFile(params: Record<string, Object>): Promise<Object | null> {
    const docPicker = new picker.DocumentViewPicker();
    const option = new picker.DocumentSaveOptions();
    const defaultName = this.stringOrOf(params, 'defaultName', '');
    if (defaultName.length > 0) {
      option.newFileNames = [defaultName];
    }
    const uris = await this.guard(async () => {
      return docPicker.save(option);
    }, '保存文件选择器');
    if (uris.length === 0) {
      return null; // 用户取消
    }
    return this.mountFileUri(uris[0]);
  }

  /** 选工作区目录（DIRECTORY 模式）。 */
  async pickDirectory(params: Record<string, Object>): Promise<Object | null> {
    const docPicker = new picker.DocumentViewPicker();
    const option = new picker.DocumentSelectOptions();
    option.maxSelectNumber = 1;
    option.selectMode = picker.DocumentSelectMode.FOLDER;
    const uris = await this.guard(async () => {
      return docPicker.select(option);
    }, '选择工作区目录');
    if (uris.length === 0) {
      return null; // 用户取消
    }
    const rootUri = uris[0];
    const name = this.baseNameOfUri(rootUri);
    this.persistPermission(rootUri);
    return this.mapper.mountRoot(rootUri, name);
  }

  /** 提示框（替代 webview alert）。 */
  async message(params: Record<string, Object>): Promise<Object | null> {
    const content = this.stringOrOf(params, 'content', '');
    const opts = this.optionsOf(params);
    const ui = await this.uiContext();
    return new Promise<Object | null>((resolve) => {
      ui.showAlertDialog({
        title: opts.title ?? 'Mditor',
        message: content,
        confirm: {
          value: '确定',
          action: () => {
            resolve(null);
          },
        },
        cancel: () => {
          resolve(null);
        },
      });
    });
  }

  /** 确认框（替代 webview confirm）；取消/关闭视同否。 */
  async confirm(params: Record<string, Object>): Promise<Object | null> {
    const content = this.stringOrOf(params, 'content', '');
    const opts = this.optionsOf(params);
    const ui = await this.uiContext();
    return new Promise<Object | null>((resolve) => {
      ui.showAlertDialog({
        title: opts.title ?? 'Mditor',
        message: content,
        autoCancel: false,
        primaryButton: {
          value: opts.cancelLabel ?? '取消',
          action: () => {
            resolve(false);
          },
        },
        secondaryButton: {
          value: opts.okLabel ?? '确定',
          action: () => {
            resolve(true);
          },
        },
        cancel: () => {
          resolve(false);
        },
      });
    });
  }

  // ---- 内部工具 ------------------------------------------------------------

  /** 单文件 URI → 挂载父目录 + 持久化，返回该文件的虚拟路径。 */
  private mountFileUri(fileUri: string): string {
    const slash = fileUri.lastIndexOf('/');
    const parent = slash > 0 ? fileUri.slice(0, slash) : fileUri;
    const name = this.baseNameOfUri(fileUri);
    this.persistPermission(parent);
    const rootVirtual = this.mapper.mountRoot(parent, this.baseNameOfUri(parent));
    return `${rootVirtual}/${name}`;
  }

  /** URI 权限持久化（Picker 授权重启即失效；失败软降级——本次会话仍可用）。 */
  private persistPermission(uri: string): void {
    try {
      const policy: fileShare.PolicyInfo = {
        uri: uri,
        operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE,
      };
      fileShare.persistPermission([policy]).catch((err: BusinessError) => {
        hilog.warn(0x0D01, 'mditor', 'persistPermission 失败 %{public}d %{public}s',
          err.code, err.message);
      });
    } catch (err) {
      hilog.warn(0x0D01, 'mditor', 'persistPermission 异常 %{public}s', String(err));
    }
  }

  /** 重启后重新激活已持久化的 URI（EntryAbility onCreate 调一次）。 */
  activateAll(): void {
    this.mapper.reactivate((uri: string) => {
      try {
        const policy: fileShare.PolicyInfo = {
          uri: uri,
          operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE,
        };
        fileShare.activatePermission([policy]).catch((err: BusinessError) => {
          hilog.warn(0x0D01, 'mditor', 'activatePermission 失败 %{public}d %{public}s',
            err.code, err.message);
        });
      } catch {
        // 尽力而为
      }
    });
  }

  private async uiContext(): Promise<UIContext> {
    const ability = HostContext.ability;
    if (ability === null || ability.context === null) {
      throw new BridgeError('E_INTERNAL', '宿主上下文未就绪');
    }
    const win = await window.getLastWindow(ability.context);
    return win.getUIContext();
  }

  private suffixesOf(params: Record<string, Object>): string[] {
    const raw = params['filters'];
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: string[] = [];
    const groups = raw as FilterGroup[];
    for (const f of groups) {
      if (Array.isArray(f?.extensions)) {
        const exts = f.extensions;
        for (const ext of exts) {
          out.push(ext.startsWith('.') ? ext : `.${ext}`);
        }
      }
    }
    return out;
  }

  private optionsOf(params: Record<string, Object>): DialogOptions {
    const raw = params['options'];
    if (raw === undefined || raw === null) {
      return {};
    }
    return raw as DialogOptions;
  }

  private stringOrOf(params: Record<string, Object>, key: string, dft: string): string {
    const v = params[key];
    return typeof v === 'string' ? v : dft;
  }

  /** URI 尾段作为展示名（编码还原）。 */
  private baseNameOfUri(uri: string): string {
    const slash = uri.lastIndexOf('/');
    const tail = slash >= 0 ? uri.slice(slash + 1) : uri;
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  }

  private async guard<T>(run: () => Promise<T>, what: string): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const e = err as BusinessError;
      throw new BridgeError('E_IO', `${what}失败：${e.message ?? String(err)}`);
    }
  }
}
