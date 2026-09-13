// Registry.ets —— 桥方法注册表（fs/dialog/store/app 四域在此收口）。
//
// 未注册的方法统一返回 UNSUPPORTED（前端映射 UnsupportedError）——
// MVP 明确不做的能力（AI 四命令、多窗口三命令）不注册即是声明不支持。

import { Bridge } from './Bridge';
import { HostContext } from './HostContext';
import { bundleManager } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

export function registerAll(bridge: Bridge): void {
  // ---- app 域（基础） ------------------------------------------------------
  bridge.register('app.version', async (): Promise<Object | null> => {
    const info = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    return info.versionName;
  });

  // 应用数据目录：沙箱 filesDir 的虚拟路径（UriMapper 统一映射 /AppData）。
  bridge.register('app.appDataDir', async (): Promise<Object | null> => {
    return '/AppData';
  });

  bridge.register('app.exitApp', async (): Promise<Object | null> => {
    const ability = HostContext.ability;
    if (ability !== null && ability.context !== null) {
      ability.context.terminateSelf();
    }
    return null;
  });

  // 事件广播：单窗口 MVP 下回声给页面自身（settings-changed 自愈同步）。
  // 二期多窗口/原生菜单事件再扩展为跨窗总线。
  bridge.register('app.emit', async (params: Record<string, Object>): Promise<Object | null> => {
    const event = params.event as string;
    const payload = params.payload ?? {} as Record<string, Object>;
    bridge.sendEvent(event, payload as Object);
    return null;
  });

  // 其余四域（fs.* / dialog.* / store.* 及 app 余量方法）由各模块实现文件
  // 注册（FileManager / SettingsStore / PickerBridge）——见各文件头部注释。
}
