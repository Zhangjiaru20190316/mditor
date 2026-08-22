# Mditor 修复与优化任务（4 项）

> 本文档是投喂给编码智能体的任务提示词存档。四个任务已于 v4.0.0 全部完成，
> 各项根因说明见 CHANGELOG.md 的 4.0.0 条目。

## 角色与项目背景

你是负责 Mditor 项目的资深前端工程师。Mditor 是本地优先的 Markdown 桌面编辑器，技术栈：Tauri 2 + React 18 + TypeScript（strict）+ Milkdown/ProseMirror（富文本）+ CodeMirror 6（源码模式），构建 Vite 5，测试 Vitest。代码根目录 `mditor/`：

- 组件在 `src/components/`，主应用与全局状态在 `src/App.tsx`
- 纯逻辑库在 `src/lib/`，单测与源码同目录（`*.test.ts`）
- 样式为单文件 `src/styles/global.css`（BEM 风格前缀，如 `.ol-*`/`.ft-*`/`.modal-*`）+ `src/styles/themes/` 主题变量，无 CSS 框架
- 组件普遍使用 React.memo + 稳定 props + ref 镜像回调模式
- 本次四个问题均为前端问题，不改动 `src-tauri/`（Rust 侧）

## 任务清单

### Bug 1｜大纲面板不能滚动
- 现象：文档标题较多时，大纲面板下方条目被裁剪，无法滚动查看。
- 期望：大纲列表可垂直滚动到底部，滚动表现与侧栏其他面板一致。
- 定位入口：`src/components/Outline.tsx`、`src/App.tsx` 中大纲面板挂载处、`global.css` 的 `.sb-panel` 与 `.ol-*` 规则；侧栏已有可滚动面板（文件树 `.ft-scroll`、搜索 `.ws-results`）的实现模式可参考。

### Bug 2｜二级文件夹点击展开无反应
- 现象：文件树中二级及更深层文件夹点击后无反应（一级正常）。
- 期望：任意层级文件夹都能正常展开/收起。
- 定位入口：`src/components/FileTree.tsx`（`expanded` 状态与 `toggleDir`）、`src/lib/tauriFs.ts`（`readDirLevel`）、`src/lib/path-shim.ts`（路径规范化）。
- 排查线索（未经证实，仅作方向）：代码中已有 `samePath`/`isUnderPath` 等大小写不敏感比较工具，说明 Windows 下路径大小写/分隔符不一致是已知干扰源——留意展开状态的键与树节点路径之间的相等性判断方式。

### 优化 1｜设置界面分区重构
- 现象：设置弹窗约 20 项设置平铺无分组，信息层级混乱。
- 期望：按功能域分区呈现（具体分区方案由你根据现有设置项自行归纳，如外观、编辑器、行为、AI 等），使用分区标题，必要时用折叠分组。
- 硬性约束：所有设置项、默认值、行为、持久化结构（Settings 接口与 store）保持完全不变——这是纯 UI 重组，不是设置项的增删改。
- 定位入口：`src/components/SettingsModal.tsx`、`global.css` 的 `modal-*`/`field-*` 规则；已有 `field-section`/`field-collapsible` 模式可复用。

### 优化 2｜搜索结果定位到具体内容
- 现象：全局搜索点击结果只打开对应文件，不会定位到匹配的具体位置。
- 期望：源码模式下滚动定位到匹配行；富文本模式下定位到匹配文本处。
- 定位入口：`src/components/WorkspaceSearch.tsx`（`onOpenResult`）、`src/App.tsx` 的 `onOpenSearchResult`（留意其中的定时器时序）、`src/components/Editor.tsx` 与 `src/hooks/useMilkdown.ts` 的跳转接口（`jumpToSourceLine`、`revealText`）、`src/lib/anchorSearch.ts`。
- 排查线索（未经证实）：搜索结果数据结构已包含行号/列号；时序类失败（文件刚打开、编辑器尚未就绪导致跳转被静默吞掉）可能性较大——修复应建立在确定性的「文件加载完成后」时机上，而不是简单加大固定延时。

## 工作纪律（每一条都是硬性要求）

1. **先根因后动手**：每个问题必须先定位根因并给出代码证据再修改；优先根因修复，禁止绕过式 workaround，禁止未定位就猜测性连改。
2. **最小 diff**：只改与四个任务直接相关的代码；禁止顺手重构、格式化无关代码、调整无关文件；不新增任何依赖。
3. **复用既有模式**：滚动、折叠、样式一律参考项目内已有实现；新样式沿用 BEM 前缀与主题 CSS 变量（`--bg`/`--fg`/`--border`/`--accent` 等），禁止硬编码颜色。
4. **一任务一提交**：四项各自独立 commit（conventional commit：`fix:`/`refactor:`），任何一项出问题可单独回滚。
5. **防回归测试**：可单测的纯逻辑（如路径比较、设置项清单）补 Vitest 用例；CSS/交互类修复至少在应用内人工验证，并在交付说明中记录复现步骤与验证结果。

## 性能红线

- 遵守项目 React.memo 惯例：传给 memo 子组件的新回调必须用 useCallback/ref 镜像稳定化，禁止 render 期内联新函数引发重渲染风暴。
- 设置重构不得改变「draft 本地暂存、确认后一次性提交」的读写时序，不得造成输入过程频繁写 store。
- 滚动修复采用 CSS 布局手段（flex/min-height/overflow），禁止 JS 滚轮劫持或轮询。
- 搜索定位禁止无限轮询或定时器堆叠；等待编辑器就绪须用已有事件/回调或有限次退避，并确保清理所有定时器与监听。

## 防回归清单

- 大纲点击跳转（`jumpToHeading`）、文件树一级目录展开、搜索打开文件等既有行为不得回归。
- 设置重构前后设置项集合与默认值必须完全一致（建议为设置项清单写快照比对单测）。
- 主题切换（light/dark 等）下新改动样式不得出现硬编码颜色残留。

## 验收门槛（全部满足才算完成）

在 `mditor/` 目录执行：
1. `npm test` 全绿（既有用例零回归 + 新增用例通过）
2. `npm run build`（含 `tsc --noEmit`）0 错误
3. `npm run lint` 0 错误
4. `npm run tauri dev` 人工验证四项：长大纲可滚动见底 / 三层以上文件夹展开正常 / 设置弹窗分区且每项功能与重构前一致 / 搜索点击后定位到匹配行（源码与富文本两种模式各验一次）

## 交付物

1. 四个独立 commit
2. 每项的根因说明、改动摘要、验证结果（参照 `CHANGELOG.md` 既有记录风格：根因 + 修复 + 防回归 + 验证计数）
3. 如有无法定位根因的问题，如实报告排查过程与证据，不得带病硬改
