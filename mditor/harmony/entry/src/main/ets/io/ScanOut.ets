// ScanOut.ets —— WatchManager TaskPool 扫描的结果形状（N8）。
//
// 独立模块的原因：@Concurrent 函数只能引用 import 绑载/局部变量与
// @Sendable 类，且该类必须经 import 引入（同文件声明会被 es2abc 拒绝）；
// @Sendable 字段必须是 sendable 类型（boolean/number/string 与
// collections.Array，普通 Array 不是）。

import { collections } from '@kit.ArkTS';

@Sendable
export class ScanOut {
  overLimit: boolean = false;
  paths: collections.Array<string> = new collections.Array<string>();
  isDirs: collections.Array<boolean> = new collections.Array<boolean>();
  mtimes: collections.Array<number> = new collections.Array<number>();
  sizes: collections.Array<number> = new collections.Array<number>();
}
