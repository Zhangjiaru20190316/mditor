// Registry.ets —— 桥方法注册表（fs/dialog/store/app/ai/net 五域收口）。
//
// 未注册的方法统一返回 UNSUPPORTED（前端映射 UnsupportedError）——
// 明确不做的能力不注册即是声明不支持：
//   * 多窗口三命令（create_doc_window/stash_tab_payload/take_tab_payload）
//     —— P6 spike 待真机，未实施
//   * get_pending_file（无 CLI 参数语义，前端适配器直接返回 null）
// 命名与前端 platform/types.ts 一一对应，两端对表（设计书 5.3）。
// 参数键为前端原样 camelCase（Tauri 的 snake_case 转换只发生在 Rust 侧，
// 鸿蒙桥没有这层）。

import { Bridge } from './Bridge';
import { HostContext } from './HostContext';
import { bundleManager } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { UriMapper } from '../io/UriMapper';
import { FileManager } from '../io/FileManager';
import { SettingsStore } from '../store/SettingsStore';
import { DialogBridge } from './DialogBridge';
import { AiBridge } from '../ai/AiBridge';
import { S3Bridge } from '../net/S3Bridge';
import { WatchManager } from '../io/WatchManager';

/** 惰性单例：Index.aboutToAppear 时初始化（HostContext.ability 已就绪）。 */
let uriMapper: UriMapper | null = null;
let fileManager: FileManager | null = null;
let settingsStore: SettingsStore | null = null;
let dialogBridge: DialogBridge | null = null;

export function mapperInstance(): UriMapper | null {
  return uriMapper;
}

export function registerAll(bridge: Bridge): void {
  const ability = HostContext.ability;
  const filesDir = ability !== null && ability.context !== null
    ? ability.context.filesDir
    : '/data/storage/el2/base/haps/entry/files';

  uriMapper = new UriMapper(filesDir);
  fileManager = new FileManager(uriMapper);
  settingsStore = new SettingsStore(filesDir);
  dialogBridge = new DialogBridge(uriMapper);
  if (dialogBridge !== null) {
    dialogBridge.activateAll();
  }

  const fm = fileManager;

  // ---- fs 域 --------------------------------------------------------------
  bridge.register('fs.readTextFile', (p) => fm.readTextFile(p));
  bridge.register('fs.readFile', (p) => fm.readFile(p));
  bridge.register('fs.writeTextFile', (p) => fm.writeTextFile(p));
  bridge.register('fs.writeFile', (p) => fm.writeFile(p));
  bridge.register('fs.readDir', (p) => fm.readDir(p));
  bridge.register('fs.mkdir', (p) => fm.mkdir(p));
  bridge.register('fs.exists', (p) => fm.exists(p));
  bridge.register('fs.stat', (p) => fm.stat(p));
  bridge.register('fs.rename', (p) => fm.rename(p));
  bridge.register('fs.remove', (p) => fm.remove(p));

  // ---- dialog 域 ----------------------------------------------------------
  if (dialogBridge !== null) {
    const db = dialogBridge;
    bridge.register('dialog.pickOpenFile', (p) => db.pickOpenFile(p));
    bridge.register('dialog.pickSaveFile', (p) => db.pickSaveFile(p));
    bridge.register('dialog.pickDirectory', (p) => db.pickDirectory(p));
    bridge.register('dialog.message', (p) => db.message(p));
    bridge.register('dialog.confirm', (p) => db.confirm(p));
  }

  // ---- store 域（键与格式与桌面 mditor.json 完全一致） ---------------------
  if (settingsStore !== null) {
    const st = settingsStore;
    bridge.register('store.get', (p) => Promise.resolve(st.get(p)));
    bridge.register('store.set', (p) => Promise.resolve(st.set(p)));
    bridge.register('store.delete', (p) => Promise.resolve(st.delete(p)));
    bridge.register('store.save', (p) => st.save(p));
  }

  // ---- app 域 -------------------------------------------------------------
  bridge.register('app.version', async (): Promise<Object | null> => {
    const info = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    return info.versionName;
  });

  // ---- ai 域（v4.13 P2：ArkTS SSE 代理，契约对齐 src-tauri/src/ai.rs）-------
  const aiBridge = new AiBridge(bridge);
  aiBridge.registerAll();
  // 页面重载：在途流全部取消（事件消费方随页面销毁，冷启动后重挂）。
  bridge.onReload(() => {
    aiBridge.onReload();
  });

  // ---- net 域（v4.13 P3：ArkTS SigV4，契约对齐 src-tauri/src/s3.rs）---------
  const s3Bridge = new S3Bridge(bridge);
  s3Bridge.registerAll();

  // ---- fs.watch（v4.13 P4：stat 轮询，事件 fs-watch-event 按 watchId 过滤）--
  const watchManager = new WatchManager(bridge, fm);
  watchManager.registerAll();
  // 页面重载：全部 watcher 清理（前端冷启动重挂）。
  bridge.onReload(() => {
    watchManager.onReload();
  });

  // 应用数据目录：沙箱 filesDir 的虚拟路径（UriMapper 统一映射 /AppData）。
  bridge.register('app.appDataDir', async (): Promise<Object | null> => {
    return '/AppData';
  });

  bridge.register('app.appendLog', (p) => fm.appendLog(p));

  // 鸿蒙无公共回收站 API：永久删除（前端确认文案已注明不可恢复）。
  bridge.register('app.trashFile', (p) => fm.trashFile(p));

  bridge.register('app.exitApp', async (): Promise<Object | null> => {
    const ability2 = HostContext.ability;
    if (ability2 !== null && ability2.context !== null) {
      ability2.context.terminateSelf();
    }
    return null;
  });

  // 事件广播：单窗口 MVP 下回声给页面自身（settings-changed 自愈同步）。
  // 二期多窗口/原生菜单事件再扩展为跨窗总线。
  bridge.register('app.emit', async (params: Record<string, Object>): Promise<Object | null> => {
    const event = params.event as string;
    const payload: Object = params.payload ?? ({ } as Record<string, Object>);
    bridge.sendEvent(event, payload);
    return null;
  });

  // 用系统浏览器打开链接（UIAbilityContext.openLink，API 12+）。
  bridge.register('app.openExternal', async (params: Record<string, Object>): Promise<Object | null> => {
    const target = params.target as string;
    const a = HostContext.ability;
    if (a !== null && a.context !== null && typeof target === 'string' && target.length > 0) {
      await a.context.openLink(target, { appLinkingOnly: false });
    }
    return null;
  });

  // 窗口操作（系统窗口管理接管；MVP 仅保留收尾语义）。
  bridge.register('app.windowMinimize', async (): Promise<Object | null> => {
    const a = HostContext.ability;
    if (a !== null && a.context !== null) {
      const win = await window.getLastWindow(a.context);
      await win.minimize();
    }
    return null;
  });

  bridge.register('app.windowToggleMaximize', async (): Promise<Object | null> => {
    const a = HostContext.ability;
    if (a !== null && a.context !== null) {
      const win = await window.getLastWindow(a.context);
      await win.maximize();
    }
    return null;
  });

  // 关窗收尾协议：先广播 window-close-requested 给页面（App 的
  // onCloseRequested 监听驱动 shutdownSequence 落盘/确认），给 1.2s
  // 收尾窗口后终止进程。preventDefault 在鸿蒙 MVP 下是 no-op（关闭不可
  // 拦截），脏缓冲依赖自动保存兜底——已知限制见 harmony/README.md。
  bridge.register('app.closeWindow', async (): Promise<Object | null> => {
    bridge.sendEvent('window-close-requested', ({ } as Record<string, Object>));
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 1200);
    });
    const a = HostContext.ability;
    if (a !== null && a.context !== null) {
      a.context.terminateSelf();
    }
    return null;
  });
}
