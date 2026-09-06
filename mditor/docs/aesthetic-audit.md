# 美学审计报告（阶段 0）

基线：`npm run build` ✓（12.8s）· `npm run test` ✓（53 文件 / 578 用例）· `npm run lint` ✗→✓（存量 125 错误全部位于 `perf/*.mjs` 性能脚本与 1 处测试解构占位：eslint ignores 漏了 `perf/` 目录 + `no-unused-vars` 未配 `_` 前缀豁免，属配置缺口，已在阶段 0 修复——配置注释本就声明「Node 脚本不在前端 lint 范围」）。

截图基线说明：本任务执行环境无法以无头方式运行 Tauri 窗口（App 启动即依赖 `invoke()` IPC），五主题目检以「令牌等值替换 + git diff 逐行核对」替代；视觉有变化的改动（阶段 3）逐条列明前后值。

## 一、动效普查表

计数：`transition:` 59 处（未令牌化）、`animation`/`@keyframes` 47 处。时长分布（transition）：0.13s×23、0.15s×19、0.12s×17、0.3s×12、0.1s×10、0.25s×3、0.2s×2、0.35s/0.18s/0.08s 各 1。缓动分布：`cubic-bezier(0.16,1,0.3,1)`×26、`(0.4,0,0.2,1)`×9、`(0.34,1.4,0.5,1)`×3、`(0.34,1.56,0.64,1)`×1、裸 `ease` 若干。

| 类别 | 代表位置（global.css 行号） | 触发动因 | 处置 |
| --- | --- | --- | --- |
| 按钮按下缩放 | :60 `button:active` | 按下 | 保留，收敛到 `--dur-fast`+`--ease-out` |
| hover 颜色过渡 | B13 组规则 :4036-4092（约 30 选择器） | 悬停 | 收敛到令牌（`--dur-fast`） |
| 弹层入场 | mb-in :231、ctx-menu-in :940、anno-in（annotation.css :107）、sel-in :4144 | 打开菜单/弹层 | 保留范式，统一 `--dur-fast`+`--ease-out`+锚点 transform-origin |
| 下拉/搜索面板 | search-in :4178、wls-pop :5232、sel-submenu :3515 | 打开 | Dropdown 范式（translateY+fade，fast） |
| 模态框进出场 | modal-card-in/out :3963-4019、qs :5090 | 打开/关闭 | 进 `--dur-base`、退 `--dur-exit`（70-80% 规则） |
| 面板滑入 | ai-panel-in :3876、sidebar width :355、focus-toolbar :1814 | 开合面板 | 进 `--dur-base`；width 过渡保留（性能论证见报告末） |
| 编排 | ai-panel 子级 30ms 级联 :3890、settings-field 级联 :4315、sb-panel-in :527 | 首次打开 | 保留（仅首次，滚动不重放） |
| 列表项 hover | ft-row/ol-row/rc-row | 悬停 | 收敛 fast |
| 选中态游移 | settings-nav-ind :2030（transform 平移 ✓） | 导航切换 | 保留（已合规） |
| 主题切换 | body/main/modal 颜色 :3864 | 切主题 | 收敛 `--dur-slow`（颜色过渡白名单例外） |
| loading/状态循环 | typing dots/cursor、fab-pulse、agent-card-pulse、switch-bar 0.6s | 流式/加载 | 豁免（loading 指示），保留 |
| 编辑器表面切换 | editor-surface-in :4261 | 模式切换 | 保留（既有刻意设计，令牌化） |
| 大文档遮罩 | md-heavy-veil :1578 | 切换大文档 | 保留（性能工程设计，已有 reduced-motion 豁免） |
| 布局属性动画（违规候选） | field-collapse max-height :4130、resizer::before height :405、sidebar/ai-panel width :355 | 折叠/hover/开合 | resizer 改 scaleY；field-collapse 保留+论证（见报告末） |
| `transition: all` | fc-grade :5596、ai-rag-toggle :5639 | hover | 重做（白名单属性 + fast） |

## 二、样式重复模式清单

| 模式 | 出现位置（代表） | 差异点 |
| --- | --- | --- |
| 主按钮（accent 底+#fff+brightness hover） | sb-empty button :588、ctx-input-ok :1046、sb-primary :1661、btn-primary :1967、anno-btn.primary、anno-item-btn.primary、diff-apply :3063、ai-followup-send :2821、ai-mode-switch.on :2489、ai-send :3289、sel-btn.primary :3436 | 圆角 m/l、字号 xs-s-m、padding 2-8px |
| 次按钮（border+底+hover--hover） | sb-btn :1649、css-row :1939、ft-batch-btn :792、anno-btn :215、anno-item-btn :394、ai-actions :2421、ai-followup-actions :2806、diff-mini :2866、diff-act :2952、qa-del :3709、model-del :3807、dev-alert-actions :723、ws-toggle :4837 | 圆角 s/m、字号、danger 变体 |
| 虚线添加钮 | qa-add :3724、model-add :3826 | 无 |
| 图标钮（透明+fg-muted+hover 交换） | sb-close :1683、modal-x :1879、ai-clear-btn :2125、ai-close-btn :2148、diff-close :2879、qs-x :5132、anno-popover-close、dev-alert-close、ft-tool-btn :737、sb-icon-btn :1771、focus-toolbar :1827、sb-tabs :487、tabbar-tab-close :4754、ft-section-x :859 | 尺寸 18-46px、圆角 s/m/l |
| 输入框（border+--bg+focus accent） | ctx-input :1031、ws-input :4823、link-input :5047、sb-input :1639、sel-input :3472、ft-rename-input :904、ai-followup-input :2786、ai-input :3273、ai-prompt-area :3651、anno-edit-area :242、anno-item-edit :436、field-control :1911、qa-\* :3681-3707、model-\* :3775-3805 | 圆角 m/l、padding、字号 |
| 菜单项（透明+hover accent-soft） | mb-item :243、ctx-menu-item :952、sel-menu-item :3599、qs-item :5148、wls-item :5234、ai-rag-src :5684 | 圆角 s/m/字面 4-6px |
| 弹层容器（card-bg+border+shadow-lg+fixed） | mb-dropdown :218、ctx-menu :923、sel-popout :3450、sel-submenu :3498、wls-pop :5221、anno-popover :95、anno-diag :515 | padding 4-6px、min-width |
| 计数胶囊（accent-soft+999px） | ws-file-count :4879、sb-status-sel :5063、sb-count、ai-ctx-tag :2210、lp-count :5278、apr-op-kind :2672 | padding/字号 |
| hover 行（--hover 底+radius-m） | ft-row :634、ol-row :1080、rc-row :1145、ws-hit :4888、settings-nav-btn :2000、lp-item :5298 | padding/margin |
| 焦点环 | B13 组 :4093-4118、anno-item(-2 offset)、ai-quick-btn、settings-nav-btn(-2) | offset ±1/−2 |

## 三、硬编码普查表（孤儿值）

圆角（字面 px，除 999px/50%/气泡尾角/发丝线特形外共 17 处）：resizer::before 2px :403（特形-发丝线）、qs-x 4px :5138、qs-item 6px :5154、wikilink 4px :5199/:5215、wls-pop 8px :5227、lp-count 8px :5281、lp-ctx-hit 3px :5327、lp-tag 12px :5345、citation 4px :5368、md-refs-widget 8px :5377、fc-panel 12px :5486、fc-grade 8px :5591、ai-rag-toggle 12px :5633、ai-rag-src 5px :5693、qs-panel 10px :5101、lp-item 6px :5300、md-flashcard 8px :5450。

阴影（非 var）共 8 处：qs-panel :5104、wls-pop :5230、fc-panel :5488、fc-card:hover :5530、sel-swatch 内圈×2 :3564/:3570、anno 代码行 inset×2（annotation.css :484/:489，特形豁免）。

z-index（字面）共 28 处，取值集 {5,30,35,40,50,51,60,61,70,85,90,91,94,95,96,100,105,110,200(vendor),9999}。

字号（铬层字面 px）集中于 v4.7 知识功能区：15/13/12/12.5/12/11.5/11/10.5/10px 约 30 处（qs/wls/lp/cp/fc/rag 段落）。

## 四、问题分级

- **P0（破坏一致性）**：① `.fc-overlay` 引用不存在的 `modal-in` keyframes（实为 `modal-bg-in` 笔误）→ 入场动画静默失效；② v4.7 知识功能区整体游离于令牌体系外（圆角/阴影/字号/时长全套字面值，深色主题下阴影为固定黑色不随主题加深）；③ `transition: all` 两处。
- **P1（缺失体系）**① 动效无令牌（10 种时长、5 种缓动各自为政）；② z-index 无阶梯令牌；③ 阴影缺中档；④ 间距无阶梯；⑤ annotation.css `[data-motion="off"]` 死选择器（实际档位值为 `none`）。
- **P2（精修项）**：① 弹层 transform-origin 未指向锚点；② resizer::before 过渡 height（违规属性）；③ 退出动效未按 70-80% 规则收缩；④ QuickSwitcher 逐项编排不可行（列表按键过滤重挂载，编排会在打字时重放——明确不做）；⑤ 选中高亮游移（qs/wls 为背景色类切换，改 transform 需结构改造——明确不做，记录理由）；⑥ field-collapse 的 max-height/margin 过渡（存量实现，论证保留）。

## 附：width / max-height 过渡保留论证（C.4 红线的性能论证例外）

- `.sidebar`/`.ai-panel` 的 width 过渡：仅用户点击开合时触发（低频、单次 220ms），拖拽调宽时 `body.is-resizing` 已禁用过渡；编辑器/侧栏均有 `contain: layout style` 隔离，重排不级联进正文；改为 scaleX+clip 方案需重构浮岛边框/阴影/内部布局，风险大于收益。
- `.field-collapse` 的 max-height+margin 过渡：设置弹窗内低频折叠区，高度上限 1000px、过渡仅颜色+布局各 300ms；transform 化需 JS 测高（WAAPI），留待后续。
