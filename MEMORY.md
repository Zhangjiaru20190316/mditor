# MEMORY.md — 长期记忆（精炼层）

> 日志在 memory/YYYY-MM-DD.md；这里只放跨会话仍有用的结论与教训。

## Mditor 项目

- 性能/诊断基建在 `mditor/perf/`（CDP 驱动基准 + 剖面 + rect-spy）；
  dev 实例用 `npx tauri dev --config src-tauri/tauri.dev.conf.json`
  （identifier com.mditor.app.dev，**tauri.dev.conf.json 不会自动合并，
  必须 --config 传**）。
- 大文档卡顿三轮结论（2026-08-27，详见 docs/performance.md）：
  1. 聚焦切换 CSS 变量翻转 = 全子树重算雷（762ms→0，V4.6.0）。
  2. 虚拟光标每事务 rect 读 = 强制布局（patch rAF 合并，V4.6.0）。
  3. **选中链路（拖选/三击/点公式）0.7~1.7s = 全量渲染 DOM（21 万节点）
     的原生强制布局，JS 占比 <10%；杀读者无效（预付布局款），唯一杠杆
     = content-visibility**。V4.6.1 新增 bigDocViewport 子开关（默认关）：
     c-v 与减配解耦、保留 KaTeX/CodeMirror，实测选中交互降到 24~96ms。
  4. MD-4011「DOM 持续增长」曾是跨文档切换的检测器假阳性（已修 docKey
     尾段切割）；复核口径：心跳 dom/cm/katex 三计数同窗平稳即无泄漏。
- **基准纪律：同一开发机跨时段负载漂移实测 2-3 倍**——单轮跨时段对比
  不可信，必须同窗口 ABAB 交错 + CPU 剖面归因。
- **floating-ui 的 observeMove 轮询读 rect 不是寄生成本**（替同帧绘制预付
  布局款，补丁实验无差异已回退）——别再追。打开 ~2s 长任务=首次全量布局，
  与解析无关（221KB 解析 <5ms），c-v 是唯一杠杆。
- 测量纪律：测试打字会被 autosave 写盘——永远用文档副本；生产实例可能正在
  运行（单实例插件会转发），dev 必须 .dev identifier；seed JSON 路径用正斜杠；
  Tauri store 的 settings 在 Rust 侧缓存——手改 mditor.json 后必须整体重启
  dev 实例（reload 无效）；TaskStop 杀 tauri dev 后 vite/cargo 子进程残留
  占 1420/9223，netstat 补刀。

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
