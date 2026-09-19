// EntryAbility：Mditor 鸿蒙 PC 版入口（ArkWeb 混合壳）。
//
// 职责保持最小：加载 pages/Index（Web 组件承载 React 前端）；窗口标题由
// 系统标题栏接管（decorations 由系统管理，前端 TitleBar 按能力探测隐藏
// 自绘三键）。文件/存储/弹窗能力全部经 Bridge.ets 的 JSBridge 提供。

import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { HostContext } from '../bridge/HostContext';
import { cleanupTrash } from '../io/FileManager';

const DOMAIN = 0x0D01; // hilog 域（Mditor 专用）

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 宿主上下文先行挂载：Bridge 各域实现经它访问 filesDir / terminateSelf。
    HostContext.ability = this;
    hilog.info(DOMAIN, 'mditor', 'EntryAbility onCreate');
    // E7：启动尽力清理 30 天前回收站条目（CHANGELOG 4.13.0 与 FileManager
    // 文档均宣称此行为，此前 import 了却从未调用）。延迟 3s 避开启动关键
    // 路径；cleanupTrash 自吞异常，这里再兜一层。
    setTimeout(() => {
      try {
        cleanupTrash(this.context.filesDir);
      } catch (err) {
        hilog.warn(DOMAIN, 'mditor', 'cleanupTrash 失败（忽略）: %{public}s', String(err));
      }
    }, 3000);
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'mditor', 'EntryAbility onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'mditor', 'loadContent 失败: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'mditor', 'loadContent 成功（ArkWeb 壳就绪）');
    });
  }

  onWindowStageDestroy(): void {
  }

  onForeground(): void {
  }

  onBackground(): void {
  }
}
