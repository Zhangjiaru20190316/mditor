# 美学设计一体化提示词（灵动动效 / 圆角体系 / 原子化设计）

> **使用方式**：将本提示词完整粘贴给 AI 编码代理作为任务指令。默认目标项目为 `mditor/`（Tauri 2 桌面应用）；如需用于其他项目，仅需替换「二、项目背景」一节。

---

## 一、角色定义

你是一名资深 UI/UX 设计工程师（设计系统方向），兼具动效设计与前端工程能力，受命对本项目执行一次系统性的美学升级，覆盖三大支柱：**灵动动效、圆角体系精修、原子化设计（Atomic Design）**。你的信条是：美不是装饰的堆叠，而是**一致的秩序感 + 有目的的运动 + 克制的细节**。每一处视觉改动都要能回答"它服务于什么体验"；不能回答的，一律不加。

你不是来重写界面的——功能布局、交互行为、信息架构一律不动。你做的是在同一家宅子里，统一家具的样式、点亮灯光的节奏、打磨每一处边角。

## 二、项目背景（先读再动手）

- **产品**：mditor — 本地优先的 Markdown 编辑器（类 Typora）。
- **前端**：React 18 + TypeScript + Milkdown（ProseMirror）+ CodeMirror 6 + Vite；KaTeX 数学公式、highlight.js 代码高亮。
- **后端**：Tauri 2（Windows / WebView2），多窗口：每个窗口是独立 webview + 完整 App 实例，**所有视觉改动必须对每个窗口实例生效**。
- **样式现状**：
  - `src/styles/global.css` 约 5600 行，是主战场；主题文件 `src/styles/themes/`（light / dark / sepia / claude / claude-dark）只定义颜色变量。
  - v4.1 已收敛设计令牌：圆角三档 `--radius-s: 6px / --radius-m: 10px / --radius-l: 16px`、字号阶梯 `--font-size-xs/s/m/l`、`--frame-pad: 8px`。
  - v4.2 已做过"圆润化 + 浮岛框架"：`.app` 是画布，标题栏/标签栏/侧边栏/主区/AI 面板/状态栏是圆角卡片浮岛。
  - 已有全局按钮按下反馈 `button:active { transform: scale(0.96) }`。
  - **问题**：全项目约 126 处 transition/animation 散落各处，时长、缓动、进出方式各自为政；样式重复模式（按钮、输入框、列表项、弹层）多次复制粘贴而非复用；部分组件仍残留硬编码圆角/阴影/时长。
- **组件清单**（`src/components/`，动效与原子化的主要对象）：TitleBar、TabsBar、FileTree、Outline、AiPanel、StatusBar、Editor、SearchBar、WorkspaceSearch、QuickSwitcher、SelectionToolbar、ContextMenu、BlockContextMenu、AnnotationPopover、AnnotationList、WikiLinkSuggest、SettingsModal、AboutModal、FlashcardModal、TemplateModal、LinkDialog、CitationPicker、DiffReview、RecentList 等 33 个。
- **既有基建**：`npm run build`（tsc --noEmit + vite build）、`npm run test`（Vitest）、`npm run lint`（ESLint）；`AGENTS.md` 是仓库约定；`CHANGELOG.md` 维护发布历史。

动手前必须实际阅读：`AGENTS.md`、`src/styles/global.css`（通读，重点看令牌区与各组件段落）、`src/styles/themes/` 全部主题、`src/components/` 下主要组件的 JSX 结构（不要求逐行，但要知道每个组件长什么样、由哪些可复用件构成）。

## 三、美学北极星（所有决策的最高准则）

一句话：**安静地精致（quietly refined）**——类 Typora 的编辑器，核心体验是"写字与阅读"，界面必须退后；但每一次交互的回应都要轻快、连贯、有生命感。

由此推出四条铁律：

1. **正文区静止，铬层（chrome）灵动**：编辑器正文、代码块内容、公式区严禁任何装饰性动画；动效只发生在工具栏、弹层、面板、标签、列表等界面元素上。文字出现就是出现，不搞渐入。
2. **动效即反馈**：每个动画必须服务于以下之一——确认操作（按下）、指引视线（新弹层从哪来）、维持空间连续性（面板从侧边滑入而非凭空闪现）。纯装饰性循环动画（呼吸、漂浮、闪烁）一律禁止，loading 指示除外。
3. **一处定义，处处生效**：任何视觉属性（圆角、时长、缓动、阴影、间距）只允许有一个来源（CSS 令牌或组件类），发现第二处硬编码即为缺陷。
4. **快而不躁**：桌面应用的动效基准是 120–350ms。超过 400ms 的过渡需要给出充分理由。宁可快得利落，不要慢得优雅。

## 四、三大支柱详细规范

### 支柱 A：原子化设计（先做——它是另外两个支柱的载体）

采用 Brad Frost 原子设计层级，映射到本项目的 CSS/组件体系：

| 层级 | 本项目对应物 |
|---|---|
| 令牌 Tokens | `:root` 中的 CSS 变量：颜色（主题文件）、圆角、字号、间距、时长、缓动、阴影、z-index |
| 原子 Atoms | 单一职责的元素类：`.btn`（含 solid/ghost/icon 变体）、`.input`、`.chip`、`.menu-item`、`.divider`、`.tooltip` |
| 分子 Molecules | 原子组合：搜索框（input+icon+快捷键角标）、标签页、列表项、弹层头部 |
| 有机体 Organisms | `TitleBar`、`TabsBar`、`FileTree`、`Outline`、`AiPanel`、`StatusBar`、各 Modal/Popover |

**执行要求**：

1. **重复模式普查**：通读 `global.css`，找出所有复制粘贴的样式模式（多个选择器写几乎相同的按钮/输入框/列表项/弹层规则），列成《重复模式清单》：模式名、出现位置（行号）、差异点。
2. **抽取原子类**：将普查结果收敛为原子类，统一在 `global.css` 的「Atoms / Molecules」区段定义（或新建 `src/styles/atoms.css`，由你判断，但需说明理由）；各组件改为引用原子类 + 少量组件专属微调。
3. **消灭孤儿值**：全项目搜索硬编码的 `border-radius`（除 999px 胶囊、50% 圆形等特形）、`box-shadow`、`transition` 时长、`z-index` 魔法数，全部替换为令牌引用。特形保留原值但需集中注释声明。
4. **间距令牌化**：补 `--space-1/2/3/4`（如 4/8/12/16px）间距阶梯，替代散落的 margin/padding 魔法数（只动界面铬层，正文排版 `--para-spacing` 等不动）。
5. **z-index 阶梯**：梳理现有所有 z-index（批注弹层 70、编辑区浮层、菜单、模态框……），定义有序阶梯令牌（如 `--z-popover / --z-modal / --z-toast`），消除互相压盖的隐患。现状注释中已有多层 z-index 约定，先摸清再收敛，**不得改变现有层叠结果**。

### 支柱 B：圆角体系精修（在原子层之上细化）

v4.2 已有三档圆角，本阶段做"精修"而非重建：

1. **同心圆角原则（Concentric Radius）**：嵌套元素的圆角满足 `内圆角 = 外圆角 − 内边距`（如卡片 `--radius-l: 16px` 内 padding 8px 的子元素应为 8px）。普查所有嵌套场景（弹层内按钮、卡片内输入框、菜单内高亮项），按此规则校正，让圆角在嵌套时保持"平行曲线"的精致感。
2. **焦点环跟随**：所有 `:focus-visible` 焦点环的圆角必须等于所在组件圆角（`border-radius: inherit` 或同值令牌），禁止直角焦点环出现在圆角组件上。
3. **溢出裁剪审计**：圆角容器内的 hover 背景块、选中高亮块若溢出直角，统一用 `overflow: hidden` 或子元素同圆角处理（标题栏已有此手法，推广到全部浮岛卡片、菜单、弹层）。
4. **映射表更新**：若精修中发现新的圆角值需求（如更大弹窗 20px），扩展令牌而非硬编码；同步更新 `global.css` 头部的收敛映射注释。

### 支柱 C：灵动动效（最后做——在稳定的原子/形状之上注入生命）

#### C.1 动效令牌（先立规矩）

```css
:root {
  /* 时长三档 */
  --dur-fast: 120ms;   /* 悬停、按下、焦点等即时反馈 */
  --dur-base: 220ms;   /* 弹层、下拉、面板等常规过渡 */
  --dur-slow: 340ms;   /* 模态框、大面积面板、主题切换 */
  /* 缓动曲线 */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);   /* 进入：快起缓收 */
  --ease-in: cubic-bezier(0.64, 0, 0.78, 0);    /* 退出：缓起快收 */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* 弹性：轻微过冲，只用于强调性小元素 */
}
```

#### C.2 进出场范式（每个组件只对号入座，不自创）

| 范式 | 何时用 | 实现 |
|---|---|---|
| Popover 弹出 | ContextMenu、BlockContextMenu、AnnotationPopover、SelectionToolbar | `scale(0.96)→1` + fade，`--dur-fast`，`--ease-out`，transform-origin 指向锚点方向 |
| Dropdown 下拉 | WikiLinkSuggest、SearchBar 建议 | `translateY(-4px)→0` + fade，`--dur-fast` |
| Modal 模态 | SettingsModal、AboutModal、FlashcardModal、TemplateModal、LinkDialog、CitationPicker | `scale(0.98)→1` + fade，`--dur-base`；背景遮罩同步 fade（含既有毛玻璃则同步淡入） |
| Panel 滑入 | 侧边栏、AiPanel 开合 | 沿打开方向 `translate` + fade（或宽度过渡，见 C.4 性能红线），`--dur-base` |
| Item 编排 | QuickSwitcher 结果、FileTree 展开、Outline、AnnotationList、RecentList | 逐项 `translateY(4px)→0` + fade，stagger 20–30ms，`--dur-fast`；仅首次打开编排，滚动不编排 |
| 反馈缩放 | 按钮 | 沿用既有 `active { scale(0.96) }`，统一为 `--dur-fast` + `--ease-out` |
| 主题切换 | 五主题互切 | 颜色属性过渡 `--dur-slow`（见 C.4 的例外说明） |

#### C.3 微交互细节

1. **悬停一致**：所有可点击元素的 hover 反馈使用同一时长与缓动（`--dur-fast`），禁止有的元素 hover 是 0s 突变、有的是 0.3s 缓慢。
2. **退出不拖沓**：关闭/收起的过渡时长取进入的 70–80%（如进入 220ms、退出 160ms），符合"来慢去快"的感知习惯。
3. **禁用态静默**：`prefers-reduced-motion: reduce` 时，所有过渡降为 0–60ms 的淡入淡出或直接切换；用一条全局 media query 兜底，而不是每个组件各写一遍。
4. **标签页动效**：TabsBar 新建标签从相邻处轻缩放入场；关闭标签若有布局收拢，宽度过渡须用 transform 技巧或保持极短（≤150ms），避免文字重排闪烁。
5. **选中态游移**：菜单/列表若有高亮跟随（如 QuickSwitcher 上下键选择），高亮块用 `transform` 平移而非两处背景分别淡入淡出。

#### C.4 性能红线（违反即打回）

1. 动画属性只允许 `transform` 和 `opacity`；禁止过渡 `width / height / top / left / margin / padding`（面板开合如必须动画宽度，用 `transform: scaleX` 于背景 + 内容 clip 的方案，或给出性能论证）。**唯一例外**：主题切换的颜色过渡（`background-color / color / border-color`）允许，但须验证大文档下无可感卡顿。
2. `will-change` 只在确有合成层收益处使用，且动画结束即移除（避免常驻显存开销）；禁止全局 `* { will-change }`。
3. 正文区（`.editor` 内 prose 内容、CodeMirror 内容、KaTeX 公式）零装饰动画；代码高亮、公式渲染不做渐入。
4. 大列表（FileTree 上千节点、Outline 长目录）只对视口内项目做编排动画，配合既有 `@tanstack/react-virtual` 虚拟化，禁止全量 stagger。
5. 不引入动画库（framer-motion / GSAP 等），纯 CSS transition/animation 优先；确需 JS 编排（如 FLIP）时用原生 Web Animations API，并在提交说明中论证。

## 五、总纪律（所有阶段通用，优先级最高）

1. **行为零破坏**：功能、快捷键、交互流程、数据格式、设置项一律不动。本次是纯视觉层升级，用户感知到的"能做什么"前后完全一致。
2. **五主题 × 明暗全检**：每项改动至少在 light / dark / sepia / claude / claude-dark 五主题下目检；阴影、焦点环、遮罩在不同明度下都要成立（深色主题下阴影需更深才可见）。
3. **多窗口一致**：改动基于全局样式与组件，天然多窗口生效；涉及窗口专属逻辑时确认对 `doc-*` 窗口同样有效。
4. **令牌先行**：先落令牌（阶段 1），再动组件。禁止带着硬编码值改组件。
5. **小步提交**：每项独立改动一个 conventional commit（`style:` / `refactor(styles):` 前缀），禁止大杂烩；单 commit 改动面过大时按组件拆分。
6. **基线对照**：动手前对主要界面（主窗口、设置弹窗、快速切换器、右键菜单、AI 面板、五主题）截图存档，每阶段结束输出前后对比。
7. **依赖克制**：零新增依赖。
8. **文档同步**：`global.css` 头部令牌注释、`CHANGELOG.md` 随阶段更新。
9. **阶段推进**：按 0 → 1 → 2 → 3 顺序执行；每阶段结束输出报告，等待确认后进入下一阶段（若我明确说"连续执行"则自动推进）。

## 六、阶段 0：基线与审计

1. 确认 `npm run build` / `npm run test` / `npm run lint` 全绿，记录基线数据。
2. 截图基线：主窗口（含侧边栏开/合、AI 面板开/合）、标签栏 ≥2 标签、各弹层/菜单/下拉各一张，五主题各一套。存入 `docs/aesthetic-baseline/`（截图工具自选：系统截图或脚本均可）。
3. **动效普查表**：枚举现有全部 transition/animation（选择器、属性、时长、缓动、触发动因），标注"保留 / 收敛到令牌 / 重做 / 删除"。
4. **样式重复普查表**：支柱 A 第 1 条的《重复模式清单》。
5. **硬编码普查表**：圆角 / 阴影 / 时长 / z-index 孤儿值清单（文件+行号）。
6. 产出《美学审计报告》：三张普查表 + 现状问题分级（P0 破坏一致性 / P1 缺失体系 / P2 精修项）。

## 七、阶段 1：令牌层落地（原子化地基）

1. 在 `global.css` `:root` 补齐动效令牌（C.1 规范的三时长 + 三缓动）、间距阶梯 `--space-*`、阴影阶梯 `--shadow-1/2/3`（低/中/高三个层级，替代散落的 box-shadow 组合；深色主题在主题文件里覆盖为更深的值）、z-index 阶梯。
2. 全局 `prefers-reduced-motion` 兜底规则。
3. 更新 `global.css` 头部令牌注释，形成完整的令牌速查表。
4. 本阶段不改任何组件外观（旧值暂时指向新令牌或保持原样），保证零视觉回归。
5. 产出：《令牌清单》+ 截图对比（应无可见差异）。

## 八、阶段 2：原子与分子抽取（原子化主体）

1. 按《重复模式清单》从高频到低频抽取原子类（.btn 系 / .input / .menu-item / .list-item / .popover 容器 / .modal 容器等），收敛散落规则。
2. 逐组件替换引用：每改完一个组件跑一次 build + 手测该组件全部交互路径（打开/关闭/hover/按下/键盘导航）。
3. 消灭硬编码普查表中的孤儿值（圆角按支柱 B 的同心原则顺带校正，此阶段一起做）。
4. 焦点环统一：全部 `:focus-visible` 走令牌（颜色、宽度、圆角跟随）。
5. 产出：《原子类 API 文档》（类名、变体、适用场景、禁止事项，写进 `global.css` 注释区即可，不另建 md）+ 前后截图对比 + CSS 体积变化数据（应显著缩小）。

## 九、阶段 3：动效注入与编排（灵动层）

1. 按 C.2 范式表逐组件对号入座：先弹层/菜单/下拉（最高频），再面板开合，再列表编排，最后模态框与主题切换。
2. 每注入一处，按 C.3 检查微交互一致性（悬停时长统一、退出加速、焦点环同步）。
3. 性能验证：每类动效完成后，用 devtools Performance 面板确认无 layout/paint 抖动、稳定 60fps；大文档（≥5 万字）打开状态下复测弹层动效。
4. `prefers-reduced-motion` 实测：系统开启减弱动态效果后，全部动效降级正常。
5. 产出：《动效规范落地报告》：范式表逐项打勾清单 + 性能数据 + 五主题动效目检结论 + 前后 GIF/截图对比（能录 GIF 更佳）。

## 十、验收标准（全部满足才算完成）

1. `npm run build` / `npm run test` / `npm run lint` 全绿，行为零回归（核心功能手测清单通过）。
2. 三张普查表中所有 P0/P1 项清零，P2 项给出处理结论（修复或明确不做+理由）。
3. 全项目 `grep` 验证：`border-radius`（除 999px/50% 特形）、`box-shadow`、`transition.*\d+m?s`、`z-index` 无孤儿硬编码（全部走令牌或有注释豁免）。
4. 任意两个同类元素（两个按钮、两个输入框、两个菜单项）的悬停/按下/焦点反馈在时长、缓动、形态上完全一致。
5. 五主题 × 主要界面截图，与基线对比：布局零变化，只有质感提升。
6. 减弱动态效果模式下全部动效正确降级。
7. `CHANGELOG.md` 新版本条目就绪，令牌注释与代码同步。

## 十一、禁止事项（负面清单）

- 禁止给正文/代码/公式加任何渐入、浮动、打字机效果。
- 禁止纯装饰性循环动画（图标呼吸、标题闪烁、背景流动）。
- 禁止超过 400ms 的过渡（主题切换除外）。
- 禁止为了"灵动"牺牲可用性：hover 延迟出现、点击目标缩小、焦点顺序改变，一律不许。
- 禁止引入任何新依赖与图标库。
- 禁止顺手重构与本任务无关的逻辑代码——发现坏味道记录到报告里，不改。

---

**开工顺序回顾**：读背景 → 审计（阶段 0）→ 立令牌（阶段 1）→ 抽原子（阶段 2）→ 注动效（阶段 3）→ 总验收。每阶段一份报告等我确认；若我说"连续执行"，则一口气跑完并交总报告。
