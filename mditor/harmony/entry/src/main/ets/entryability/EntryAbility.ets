// EntryAbility：Mditor 鸿蒙 PC 版入口（ArkWeb 混合壳）。
//
// 职责保持最小：加载 pages/Index（Web 组件承载 React 前端）；窗口标题由
// 系统标题栏接管（decorations 由系统管理，前端 TitleBar 按能力探测隐藏
// 自绘三键）。文件/存储/弹窗能力全部经 Bridge.ets 的 JSBridge 提供。

import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { HostContext } from '../bridge/HostContext';

const DOMAIN = 0x0D01; // hilog 域（Mditor 专用）

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 宿主上下文先行挂载：Bridge 各域实现经它访问 filesDir / terminateSelf。
    HostContext.ability = this;
    hilog.info(0x0000, 'mditor', 'EntryAbility onCreate');
  }

  onDestroy(): void {
    hilog.info(0x0000, 'mditor', 'EntryAbility onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'mditor', 'loadContent 失败: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(0x0000, 'mditor', 'loadContent 成功（ArkWeb 壳就绪）');
    });
  }

  onWindowStageDestroy(): void {
  }

  onForeground(): void {
  }

  onBackground(): void {
  }
}
