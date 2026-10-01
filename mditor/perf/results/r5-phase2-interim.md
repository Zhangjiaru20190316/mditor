# 第五轮 阶段二：复现取证中期发现（滚动更新）

截至 2026-10-02。dev 实例（端口 9223，视口档 on，fixture=perf/fixtures）。
探针：perf/tmp-r5/probe-j.mjs（scrollTop-setter/scrollIntoView/scrollTo 调用栈陷阱 + 200ms 采样）。
证据：r5-phase2-j-alpha-r5j-a1.json / r5-phase2-j-alpha-r5j-a2.json。

## 发现 1（J 组，2/2 轮复现）：切回标签的「落点回拽」

r5j-a2（预滚 8100 后切走再切回）时间线（tab-back 窗口）：
1. writeViewportTop 打标 tab-restore 写 scrollTop=8100（Editor.tsx:150 栈）；
2. ~29ms 后 scrollToViewportAnchor 锚块精落地（viewportAnchor.ts:70 栈）；
3. **149ms 后 anchor-comp 补偿拽回 -217px（scrollDebug.ts tick 栈），终态 7883 ≠ 保存值 8100**。
成因链：切回 → fulldoc 整批重建（pm:rebuild -383/+938）→ cvMemory 高度表重学（layout:block 波）→ 视口上方内容高度收缩 → anchor-comp 二帧确认后补偿。补偿语义=保画面内容静止（正确性待判：-217px 对应上方内容真实收缩量则视觉无损），但「先落 8100 再拽 217」若发生在用户已开始阅读时即体感乱动。
同轮 r5j-a1（保存位 0）无此形态——**回拽只在保存位>0 时出现**。

## 发现 2（F/J 同源，2/2 轮 + 生产心跳互证）：开档/切回后块高「弹跳波」

每次开档与切回后 10-20s 窗口内，同批块高度 ±16~24px 往复（a1: 202 处 +24 → 73 处 -24；a2: 168 处 +24 → 73 处 -24，同块 #40 详细解答： 40→64→40）。生产心跳 layout:height 计数同期爆炸（17→395）。机制（cvMemory.ts:125-145 buildDecos）：
- 预热批内块：content-visibility:visible → 真布局高度（64px）；
- 批过后：有学得尺寸 → intrinsic 记忆高度；学失败/未学 → 回落 3em/auto 占位（40px）。
两态差 24px × 数百块 = 视口上方内容反复位移 → 乱动（J-d）+ 若在视口内则块自身视觉跳变（乱闪 F-b）。
待定向取证：+24 的物理来源（字体度量 vs 公式占位高度 vs 记忆值滞后）——见后续 block-watcher 探针。

## 发现 3（F 组，1/2 轮复现 + 生产 ×2）：MD-1011 结构海啸的真触发者是切标签

dev 切走 → pm:rebuild **-937/+381**；切回 → **-383/+938**。与生产 2026-10-01T07:13:19 MD-1011（removed=937/added=938）完全一致——生产当时的归因语境（AI 写入）不成立，真凶=切标签路径的整篇 setValue（useMilkdown.ts:1178 setValue → loadMarkdownFull 整批替换）。headingStamp 只保标题块；rmSamples 全是 `<div.milkdown-table-block ×0>`——**表格块未被盖章覆盖**，remembered-size 随元素消亡丢失。第四轮 B3「内容哈希复活高度」的适用场景即此。

## 发现 4（J-α'' 生产专属形态）：+32s 未打标整千跳变 dev 未复现

生产 04:47 案例（file-open 写 0 位后 32s，未打标 +3000/+5000）在 dev 两轮均未出现（dev 切回后全部写入有打标，1s 内收敛）。环境差异归因：生产会话有 heal/handoff 恢复链、异步 AI 插入（Editor.tsx:842 注释：milkdown insert() 事务带 scrollIntoView，调用方可能是异步回调——PM 内部 scrollIntoView 写 scrollTop 不经 noteScrollWrite，是已证实的检测盲区类）、跨天会话状态。陷阱设施已验证可捕获此类写入（栈回溯成功）。处置：转 P2 检测盲区补打点（scrollDebug 对未归因写入抓栈），不预设写入方结论。

## 陷阱基础设施验证记录

- Element.prototype.scrollTop setter 补丁：捕获全部 3 类写入方（Editor 阶梯 / viewportAnchor / anchor-comp），栈可读（vite serve 行号）。
- __scrollDebug.events 为函数（attachScrollDebugGlobal 暴露的是 scrollEvents() 函数引用），调用后取数组。
- ghost 检测器 dev 下活跃（layout:block / pm:rebuild / longtask 事件流）。
