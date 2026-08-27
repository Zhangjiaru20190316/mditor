# MEMORY.md — 长期记忆（精炼层）

> 日志在 memory/YYYY-MM-DD.md；这里只放跨会话仍有用的结论与教训。

## Mditor 项目

- 性能/诊断基建在 `mditor/perf/`（CDP 驱动七场景基准 + 剖面工具）；dev 实例
  用 `npx tauri dev --config src-tauri/tauri.dev.conf.json`（独立 identifier
  com.mditor.app.dev）。**tauri.dev.conf.json 不会自动合并，必须 --config 传**。
- 大文档卡顿两大根修（2026-08-27，详见 docs/performance.md「交互路径卡顿治理」）：
  1. CSS 自定义属性挂在状态类上（.ProseMirror-focused 定义变量）= 失焦/回焦
     全子树样式重算雷（762ms/次）。修法：变量恒定存在。
  2. prosemirror-virtual-cursor 每事务同步读选区 rect = 强制布局。修法：
     patch-package（rAF 合并 + 同位跳过）。
- **floating-ui 的 observeMove 轮询读 rect 不是寄生成本**（替同帧绘制预付
  布局款，补丁实验无差异已回退）——别再追。打开 ~2s 长任务=首次全量布局，
  与解析无关（221KB 解析 <5ms），c-v 是唯一杠杆。
- 测量纪律：测试打字会被 autosave 写盘——永远用文档副本；生产实例可能正在
  运行（单实例插件会转发），dev 必须 .dev identifier；seed JSON 路径用正斜杠。

## 环境坑（Windows / 工具链）

- Git Bash 里 node -e 内联模板字符串转义地狱：稍复杂的脚本一律落文件再跑。
- taskkill 杀 npm 包装进程后子进程（vite 45736 那次）可能残留占端口：
  `netstat -ano | grep LISTEN` 找 PID 补刀。
- 本机生产 app：`%APPDATA%\com.mditor.app\`（settings=session 同文件
  mditor.json）；dev 实例：`com.mditor.app.dev\`。

## 工作习惯

- 用户（hh）的 mditor 是日常在用的生产工具：其笔记目录（E:\笔记 等）里的
  文件一律只读，实验用副本。
- 每完成一块：日志落 memory/、代码单点提交（message 带量化数据）、
  CHANGELOG + 相关 docs 同步——三件套缺一不可。
