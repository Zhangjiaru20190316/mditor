# 项目全面治理 · 表格视图整批重建（MD-1011 残余）+ 全量日志分诊

> 日期：2026-09-06 ｜ 版本：4.10.0-beta.2 ｜ 输入：两份现网日志（`com.mditor.app` / `com.mditor.app.dev` 的 dev-anomalies / dev-events，截至 2026-09-02）
> 流程：全量异常码分诊（按版本 × 最后复发时刻判定存活）→ 唯一存活根因定罪 → patch-package 根修 + 锚点测试 + 切换交叉淡化补强。

## 1. 全量分诊结论（9 个异常码）

判定规则：修复版本之后无复发记录 = 已修；修复版本（4.6.2-beta.1，2026-09-01 23:25 +0800 发布）之后仍复发 = 存活。

| 异常码 | 名称 | 现网计数（正式/开发） | 最后复发 | 判定 |
| --- | --- | --- | --- | --- |
| MD-1011 | PM 顶层块批量替换 | 137 / 506 | 4.6.2-beta.1（09-02 06:48Z） | **部分存活**：heading 预盖章根修生效后，剩余批次指纹全部变为表格空壳（见 §2） |
| MD-1002 | 视口内容大幅位移 | 75 / 158 | 4.6.2-beta.1（09-02 12:02Z） | 存活（MD-1011 下游：remembered size 丢失） |
| MD-9001 | 持续掉帧 | 73 / 122 | 4.6.2-beta.1 | 存活（同上游） |
| MD-1003 | 主线程阻塞 1158–2650ms | 38 / 204 | 4.6.2-beta.1 | 存活（同上游：表格视图整批重建，每个内嵌一个 Vue app） |
| MD-1001 | ghost 滚动 | 22 / 178 | 4.6.2-beta.1（09-02 12:02Z） | 存活（同上游） |
| MD-4011 | DOM 节点持续增长 | 48 / 174 | 4.6.2-beta.0（09-01 15:15Z） | 已修：`sameDocTail` 文档切换感知切割（4.6.2-beta.1 起零复发；此前 +21 万节点为切回大文档的假阳性） |
| MD-4002 | ProseMirror 视图残留 | 10 / 57 | 4.6.2-beta.0 | 已修：destroy→create 串行化（`useMilkdown` 的 `destroyed` 守卫链） |
| MD-4001 | 堆内存持续增长 | 1 / 35 | 4.6.2-beta.0 | 已修（code-block teardown 补丁 + 同上） |
| MD-6004 | 文件监听「Command watch not found」 | 10 / 0 | 4.3.0 | 已修：现用 `@tauri-apps/plugin-fs` 的 `watch`（useFileWatcher） |
| MD-5001 | 未捕获异常 ×5 | — | 4.6.1（开发版） | 已修：`scheduleUpdate` / `prewarmRange` 两符号在现行源码中均不存在（当时为开发中瞬时态） |
| MD-7002 | IO/IPC 缓慢（98s 保存） | — | 4.6.1 | 1MB 压测副本场景；4.6.2 后无记录，结案观察 |

## 2. MD-1011 残余定罪：表格视图 update() 语义反转

### 2.1 指纹漂移（根修前后各一分钟）

- 09-01 11:58–12:45（根修前）：removed≈added≈2×标题数+1，样本为文本/标题——heading id 双重替换主簇；
- 09-01 15:42 起（根修后，发布 +17 分钟）：removed==added（7/7、91/91、197/197……单批最高 199），移除样本指纹全部为 **`<div.milkdown-table-block ×0>`**——子节点已被移植走的**空壳**，即节点视图被销毁重建的现场遗留。

### 2.2 根因（`@milkdown/components` 7.22.1 `TableNodeView.update()`）

```js
update(node) {
  if (node.type !== this.node.type) return false;
  if (node.sameMarkup(this.node) && node.content.eq(this.node.content))
    return false;          // ← 反了：内容相同 →「视图不可复用，销毁重建」
  this.node = node;
  this.nodeRef.value = node;
  return true;
}
```

ProseMirror 节点视图契约：`update` 返回 `false` = 「此视图无法处理该节点，请销毁重建」。上游在**新旧节点完全相同**时返回 false。完整触发链（jsdom + 真实 Crepe 栈逐步定罪）：

1. 内容相同时 `matchesNode`（`node.eq` + 装饰相等）本可命中 → 零成本复用视图，**`spec.update` 根本不会被调用**——所以纯「同内容重载」不复现（F1 既有用例绿）；
2. 但装饰一变（cvMemory 学习尺寸 / 预热区间给块盖的 `content-visibility`/`contain-intrinsic-size` node 装饰，随切换/预热批次重算），`sameOuterDeco` 失败 → 落入 `updateNextNode` 位置回退 → `CustomNodeViewDesc.update` → `spec.update(相同节点)` → 上游返回 false；
3. `recreateWrapper` 接管：把子 DOM 移植进新包装器、旧壳留空——**生产样本里的 `<div.milkdown-table-block ×0>` 空壳就是它**；每个新壳 = 重新 mount 一个 Vue app；
4. 预热分批逐步扩大区间 → 每批装饰变化一波 → 线上 ~3 秒内 20 波、单批 -91/-199（表格密集的数学习题集文档）；
5. 危害链与 heading 主簇同构：旧元素消亡 → content-visibility remembered size 丢失 → MD-1002 位移 / MD-1001 ghost / MD-1003 长任务（Vue app 逐个 mount）。

对照实验排除项：纯 prosemirror-view 下 `Decoration.node` style 变化对普通块是**原位补丁**（P0 元素身份保持、style 更新，块不重建）——普通 H4/P/UL 无此问题；同库 code-block / diff / image / link / list-item 视图的 `update()` 语义均正确，table-block 是唯一反转者（7.22.1 全量核对）。

### 2.3 根修与 A/B 实证

`patches/@milkdown+components+7.22.1.patch` 新增 table-block hunk：内容相同分支改回 `return true`（保留视图、只更新 `this.node` 引用）→ `updateInner` 把新装饰 style 原位补在同一个包装器上；内容变化分支维持上游行为。

行为级回归（`src/lib/md1011-regression.test.ts` 新增 F6：装饰开关 + 同内容整篇重载，两张表格）：

| 腿 | 表现 |
| --- | --- |
| 补丁缺失（上游语义） | `-DIV,-DIV,+DIV,+DIV,-P` —— 与生产指纹一致，表格视图重建 |
| 补丁在位 | 顶层零替换，两张 `.milkdown-table-block` 原位保留，装饰 style（`contain-intrinsic-size` + 哨兵 `--probe-cv`）补在同一包装器上 |

另配 `src/lib/tableBlockPatch.test.ts` 源锚点测试 ×3（补丁标记在位 / 相同分支返回 true / 类型早退仍为 false）——锚点失配即「npm ci 漏跑 postinstall」或「milkdown 升级后补丁冲突」两类最现实回归面的显式报警。

## 3. 文档切换交叉淡化（体验补强）

切换动画此前只有 2px 加载条 + 大文档遮罩，内容到达无过渡。新增纯 CSS 交叉淡化：`beginSwitch` 旧内容退暗（160ms / ease-in / opacity 0.5，与侧栏 0.55 退暗同语言），内容替换发生在暗态下（无跳变），`finishSwitch` 新内容复亮（220ms / ease-out）。只过渡 opacity（合成器驱动，大文档重解析阻塞期照常播放）；「无」档与 prefers-reduced-motion **双保险豁免**（保持 opacity 1 并撤 transition，而非仅压时长——避免一帧可感闪暗）。

## 4. 验收

- `npm run build`（tsc + vite）✓ ｜ `vitest run` 582（578 + 锚点 ×3 + F6 ×1）✓ ｜ `eslint .` ✓
- `npx tauri build` 产出 `Mditor_4.10.0-beta.2_x64-setup.exe`；
- 实机复测路径（下次诊断模式会话）：切回表格密集大文档 ×5，dev-anomalies 应零新增 MD-1011/1002/1001，`pm:rebuild` 事件计数归零。
