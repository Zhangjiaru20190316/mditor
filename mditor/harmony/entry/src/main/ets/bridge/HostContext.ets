// HostContext：宿主（UIAbility）上下文的进程级持有者。
//
// EntryAbility.onCreate 把自身挂进来；Bridge 各域实现（文件/存储/窗口）
// 经它拿 context（filesDir / terminateSelf / openLink 等）。页面组件与
// Ability 生命周期解耦，桥实现不依赖 ArkUI 状态。

import { UIAbility } from '@kit.AbilityKit';

export class HostContext {
  static ability: UIAbility | null = null;
}
