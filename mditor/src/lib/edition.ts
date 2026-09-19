// 构建形态开关（鸿蒙上架纯本地版 v4.14）。
//
// 鸿蒙应用市场（AppGallery）提审时勾选「单机 APP」可免 ICP 备案，认定标准是
// 完全无网络环境下核心功能完整。因此上架 release 包要求：
//   1. module.json5 不声明 ohos.permission.INTERNET（build-harmony.mjs --offline 剔除）；
//   2. AI 助手 / 云同步入口在前端全部不存在（各组件消费本开关）。
//
// 注入方式：build-harmony.mjs --offline 以 VITE_HARMONY_EDITION=offline 跑 vite。
// 桌面端与鸿蒙 debug 内测包不设置该变量 → HARMONY_OFFLINE 恒为 false，功能全量。
export const HARMONY_OFFLINE = import.meta.env.VITE_HARMONY_EDITION === "offline";
