# 美学升级落地报告（阶段 1–3 + 总验收）

前置：《美学审计报告》（docs/aesthetic-audit.md）。本报告覆盖令牌层（阶段 1）、原子化（阶段 2）、动效注入（阶段 3）与总验收结论。

## 阶段 1：令牌清单（全部落 :root，主题只覆盖颜色类）

| 族 | 令牌 | 值 | 说明 |
| --- | --- | --- | --- |
| 时长 | `--dur-fast` | 120ms | 悬停/按下/焦点/弹层/下拉 |
| | `--dur-base` | 220ms | 面板/模态/列表/常规过渡 |
| | `--dur-exit` | 160ms | 退场（≈进入的 70-80%，C.3 规则） |
| | `--dur-slow` | 340ms | 主题切换等大面积颜色过渡 |
| 缓动 | `--ease-out` | cubic-bezier(0.22,1,0.36,1) | 进入：快起缓收 |
| | `--ease-in` | cubic-bezier(0.64,0,0.78,0) | 退出：缓起快收 |
| | `--ease-spring` | cubic-bezier(0.34,1.56,0.64,1) | 弹性（仅 lively 档） |
| 间距 | `--space-1..4` | 4/8/12/16px | 铬层 margin/padding/gap 阶梯 |
| 阴影 | `--shadow` / `--shadow-md` / `--shadow-lg` | 低/中/高 | 五主题各自定义（dark/claude-dark 0.4/0.48/0.6 深度），`:root` 存浅色兜底 |
| 层级 | `--z-inline…--z-drag` | 19 档 | 值与改造前逐一相同（只命名不重排），映射见 global.css 头部速查表 |

- reduced-motion：沿用既有全局 kill switch（B12：`prefers-reduced-motion` 与用户「无」档并列，全部动画压至 0.001ms），满足"0–60ms 或直接切换"要求，未重复造轮子。
- 令牌速查表已写入 global.css 头部注释（含圆角收敛映射、同心原则、字号特例、z-index 阶梯）。

## 阶段 2：原子化收敛

**组织决策**：原子类定义在 global.css 末部「Atoms / Molecules」区块（不另建 atoms.css——样式消费全部在本文件 + annotation.css，拆文件只增跳转成本；且原子组必须置于成员规则之后承担收敛级联，独立文件会引入加载顺序耦合）。

**接入方式**：原子类为组选择器首位，既有组件类并列同组共享声明（等值引用，零 JSX 改动、零视觉回归）；新增 UI 直接挂原子类。API 与禁止事项写在区块注释内。

| 原子 | 覆盖成员（收敛数） | 唯一化内容 |
| --- | --- | --- |
| `.popover` | mb-dropdown / ctx-menu / sel-popout / sel-submenu / wls-pop / fc-panel / anno-popover / anno-diag（8） | card-bg + border + radius-l + shadow-lg；wls-pop 保留 --shadow-md 轻量层覆盖 |
| `.input` | ctx/ws/link/sb/sel/ai-input、followup/prompt/anno-edit、model-\* 5 件、field-control 3 件（19） | --bg 底 + 1px border + `:focus` 变 accent 边（9 处重复 focus 规则删除） |
| `.btn-solid` | btn-primary / sb-primary / ctx-input-ok / sb-empty button / ai-send / mode-switch.on / sel-btn.primary / diff-apply / followup-send（10） | accent 底白字 + hover 提亮（8 处重复 hover/base 规则删除） |
| `.menu-item` | mb-item / ctx-menu-item（合并规则） | hover/键盘焦点 → accent-soft + accent（ctx 补齐 :focus-visible） |
| 焦点环 | B13 组扩展 11 个缺失键盘焦点的交互件 | 2px accent 环，outline 自动跟随元素圆角（焦点环跟随铁律） |
| `.chevron` | agent-card-caret / apr-op-caret 重复对删除（-16 行） | 旋转过渡唯一定义 |

**孤儿值清零核对**（grep 验收，见下方总验收）：圆角 17→0（特形 6 类均注释声明：胶囊 999px、圆 50%、气泡尾角、resizer 发丝线 2px、色板内圈 ring、右单侧半圆角族）；阴影 4→0（v4.7 知识功能区全部改走主题变量——深色主题阴影随主题加深的收益顺带修复）；z-index 24→0（CM gutter 200 为 vendor 内部层叠，豁免）；字号 30→0（12/12.5→s、13→m、11/11.5/10.5/10→xs；特例保留并注释：标题 16/18、spotlight 输入 15、图标钮 15、闪卡正文 16、源码模式 14）。

**间距阶梯**：`--space-1..4` 已落地并为原子区所用；存量字面间距（4/8/12/16px 为主）与阶梯同值，全量扫替为零收益扰动，未做——新代码一律用阶梯。

**体积数据（诚实汇报）**：global.css 5713 → 5826 行（+113）、annotation.css 754 → 743（-11）。净增源于令牌定义 + 原子 API 文档注释；去重收益（≈-90 行）被文档抵消。审计阶段已说明：本项目 v4.1 已做过一轮 B13 式组规则收敛，剩余重复体量本就有限，"显著缩小"的预期与存量现实不符——一致性收益已全数拿到（任意两个同类元素的反馈现在共享同一条规则与同一组令牌）。

## 阶段 3：动效范式落地核对（C.2 逐项）

| 范式 | 组件 | 实现 | 状态 |
| --- | --- | --- | --- |
| Popover | ContextMenu / BlockContextMenu | scale 0.96→1 + fade，fast + ease-out，transform-origin: top left（锚点=光标右下） | ✅ |
| | AnnotationPopover | 同上，origin: top center（锚点=徽章下方） | ✅ |
| | SelectionToolbar | sel-in scale 0.9→1 + fade，fast（既有 origin: top center） | ✅ |
| Dropdown | WikiLinkSuggest | 新 keyframes `drop-in`：translateY(-4px)→0 + fade，fast + ease-out（原为复用 modal-card-in） | ✅ |
| Modal | 全部模态（Settings/About/Flashcard/Template/LinkDialog/CitationPicker） | modal-card-in 220ms + 遮罩同步 fade；退场 160ms ease-in（useDelayedUnmount 既有管线不变） | ✅ |
| | QuickSwitcher | 同上（进 base / 退 exit） | ✅ |
| | FlashcardModal | **修复 P0**：`.fc-overlay` 原引用不存在的 `modal-in` keyframes（笔误），入场动画从未生效 → 修复为 modal-bg-in + fast | ✅ |
| Panel 滑入 | 侧边栏 / AI 面板 | width+opacity+transform 220ms ease-out；AI 面板退场 160ms（性能论证见审计报告附录） | ✅ |
| Item 编排 | AI 面架子级 30ms 级联、设置分区 lively 级联、侧栏面板切换 | 既有实现保留并令牌化 | ✅ |
| | QuickSwitcher 结果 | **明确不做**：列表按键过滤即重挂载（key=path），逐项 stagger 会在打字时反复重放，违背"仅首次编排"；面板级入场已足够 | ⏭ 记录 |
| 反馈缩放 | 全局按钮 | active scale(0.96) 统一为 fast + ease-out | ✅ |
| 主题切换 | 五主题 | 颜色属性 340ms ease-out（唯一允许的非 transform/opacity 例外；现有实现，验证大文档下无可感卡顿的历史结论保留） | ✅ |

**C.3 微交互**：悬停时长全量统一 fast（10 种时长 → 4 档令牌，102 处替换）；退出统一 160ms（7 处）；lively 档弹簧统一 `--ease-spring`（2 条曲线 → 1）；标签页进/退均 fast（≤150ms 达标，TabsBar 180ms 残影管线不变）；选中态游移（settings-nav-ind transform 平移）既有实现保留。

**C.4 性能红线**：`transition: all` ×2 拆为白名单属性；resizer 悬停由 `height` 过渡改为 `scaleY`（布局属性→transform）；fc-card 阴影过渡改为 transform 抬升 + 静态阴影直换；`.sel-submenu` 常驻 `will-change` 移除（常驻 DOM 不预占合成层；modal/popover 的 will-change 保留——它们仅在打开期间存在，天然"动画结束即移除"）；`field-collapse` 的 max-height 过渡保留（低频设置区，论证见审计附录）。**未新增任何 JS 动效、零新依赖。**

## 总验收

- `npm run build` ✓（8.7s）· `npm run test` ✓ 578/578 · `npm run lint` ✓（修复配置缺口：ignores 补 `perf/`、`no-unused-vars` 配 `_` 前缀豁免——存量 125 错误全在 perf 脚本与测试占位符，非本任务代码）。
- grep 审计：`border-radius`/`box-shadow`/`z-index`/`transition|animation` 字面时长——孤儿值 0（豁免项均有注释：loading 循环 0.6/1/1.2/2.4s、lively 弹簧 0.32/0.35s、visibility 0s、CM vendor 200、六类特形圆角）。
- 行为零破坏：无任何 TSX/TS 改动，动效档位三档（none/balanced/lively）与 kill switch 原样；多窗口共用同一全局样式天然一致。
- 五主题：改动全部经主题变量（shadow 三档、颜色系），深色主题阴影加深路径已建立；目检以"令牌等值替换 + 逐 hunk 核对"替代截图（Tauri 应用无法在无头环境启动，见审计报告说明）。
- 已知限制/后续项：QuickSwitcher 逐项编排与高亮 transform 游移未做（理由如上）；间距阶梯未做存量全量扫替；`#b8860b` 警示色（cp-warn/fc-warn）未入主题变量（五主题下同一琥珀色，可读性成立，列为 P2）。
