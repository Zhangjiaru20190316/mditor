# 大文档滚动停滚自漂移治理报告（第七轮：症状 D 专项）

> HEAD 基线 `9e0e4e9`（R6 结题未发版）→ 本轮收尾见 §6。任务书 `docs/prompts/large-doc-scroll-drift-optimization-prompt.md`。
> 全部测量产物 `perf/results/r7-*`；探针 `perf/tmp-r7/`（一次性，不入库）。测量环境同机同窗（Windows/WebView2/dpr 1.75，dev 实例 CDP 9223 惯例）。

## ① 基线声明

- **HEAD 核实**：执行第一步 `git status` + `git log` 确认 HEAD = `9e0e4e9`，与任务书 §0 声明一致，无新增提交；未跟踪杂物（`mditor/nul`、`nul`、`r6-prod-smoke.png`）与声明相符。
- **npm test 基线**：978 全绿（89 文件，38.9s）——与 R6 收尾一致。
- **fixture 在位**：密度档（156,021B/2,355 行内公式）、切换档（60,065B）、1MB（1,574,112B）、唯一公式超限档（714,088B/9,420 唯一）全在 `perf/fixtures/`（workspaces 直指该目录，dev 探针惯例）。
- **症状来源版本核实**（先于一切测量）：
  - 生产日志现卷（10-01 13:00 ~ 10-03 00:08）含 4.20.0（10-01 白天）与 **5.0.0-beta（10-01 晚起，用户最近会话）**两代实例；用户生产设置 `bigDocViewport=true / typewriterMode=false`。
  - **症状 D 的生产实锤全部落在 10-02（beta 会话）**：20 条 `layout:shift`（视口内容位移、scrollTop 未变、多数带 anchor-comp `compensated`），delta 分布 5px×8、26px×4、7~61px 各一；连续两格间隔 147ms、深滚位置（scrollTop≈26k/文档高≈131k）——「停滚后页面一格一格自己动」直接对上。
  - **MD-1001/1002/1011 生产零触发的原因**：anchor-comp 补偿带 `write:anchor-comp` 归因（stepSession 判 write 非 ghost）、单步位移 <24px 不触 MD-1002——**症状对现有异常检测器不可见，只对用户可见**。
  - dev 实例 `dev-anomalies.log` 的 MD-1001×44（4.16.0 时代 ±45729px 巨跳）为 R5 J-α 族形态，非本轮 D 形态，不并入。
  - 产物：`perf/results/r7-phase1-symptom-version-matrix.json` + `r7-phase1-prod-layout-shift-raw.jsonl`。
- **dev/main 复现结论**：R6 Fix-A/B/C 之后症状 D **仍在**（见 §2 复现矩阵）——残余形态与生产同族。

## ② 归因结论（候选定罪/排除表）

复现矩阵（D1 探针，10s 观察窗，t≥400ms 静止门后，位移阈值 4px，视口顶/中/底三哨兵 rAF 级采样）：

| 场景 | fixture | 位移帧 | 程序写入 | anchor.compΔ | MD1001/1002 | 产物 tag |
|---|---|---|---|---|---|---|
| down-fast ×3 | 密度档 | 6/6/6 | 1 | 1 | 0/1 | r7p2-2/3、r7p3-4 |
| up-fast / up-slow | 密度档 | 6 / 6 | 1 | 1 | 0/1 | r7p2 |
| **down-slow** | 密度档 | **21** | **4** | **4** | 0/0 | r7p2-1 |
| down-slow（浅深） | 1MB | 12 | 0 | 0 | 0/0 | r7p3-1 |
| **down-fast** | 1MB | **72** | 11 | **14** | 0/0 | r7p2-1 |
| **up-fast** | 1MB | **69** | 10 | **14** | 0/0 | r7p2-1 |

三项可证伪对照（决定性）：

| 实验 | 结果 | 产物 |
|---|---|---|
| 等 1MB 预热完成后复测同序列 | **位移帧 0/367、写入 0、补偿 0** | r7p2b-1 |
| typewriter 开关对照（密度档 down-slow） | 21/4/4 与关闭时完全一致，无 write:typewriter | r7p2c-1 |
| 禁 demote（DEMOTE_DELAY→1h，跑完恢复） | **位移帧 0/1708、写入 0、补偿 0** | r7p2d-1 |

| 候选 | 判定 | 证据链 |
|---|---|---|
| **D-e（新立）demote 潮宽度折行位移** | **定罪（密度档主犯）** | 占位源码文本宽 ≠ KaTeX 渲染宽，demote 批量降级时段落重新折行（layout:block 实锤：`#546 P 47→77（+30px）`）；minHeight 高度记忆只锁垂直锁不住水平。停滚后 ~2.5s（DEMOTE_DELAY）单格（快滚）或连续多格（慢滚：格间隔 >400ms 静止门，到期者连续执行 → 生产「一格一格」形态）。禁 demote → 归零；mathTrack ready 68→12 持续下降与位移格时刻对齐；泵统计 renderedΔ=0（不经渲染泵） |
| **D-b 预热分段陈旧 + up 补偿缺席** | **定罪（1MB 主犯）** | 预热三段分界按**启动时**视口（scrollTop≈0）计算；1MB 预热 >45s 未完成期间深滚后，「带下」批实际全在用户视口上方 → 变现推移视口内容却无 prewarm-comp（`prewarm.comp` 计数零增长）→ anchor-comp 逐格兜底（12 格 +424~+1301px、scrollHeight 单窗 +46,787px）。等预热完成 → 归零。次形态：up 批 dispatch→双 rAF→补偿 的跨帧可见空窗 |
| D-a 泵静止补绘上方冷条目首渲 | 部分定罪（1MB up 次要） | up-fast 1MB renderedΔ=54 与位移格并存；密度档未采到（静止补绘帧在基线前清完队列且无位移）。首渲宽度跳变（占位宽→渲染窄）与 D-e 同理但方向相反；未单列修复，随锁盒机制部分覆盖 |
| D-c 打字机延迟居中 | **排除（条件不满足）** | 开关对照完全一致；用户环境 typewriterMode=false；迟发 selectionchange 未出现 |
| D-d 其余裸源 | 未发现活跃证据 | 全部 11+ 轮采样 MD1001=0；writeTrap 除 anchor-comp 自身外仅 2 条 0→0 无害写 |

**阶段四迭代中的二级发现**（Fix-B 实现过程定罪，均写入产物）：
- 量测断批无补偿：预热 rAF 量测循环 8ms 预算断批时，已 dispatch 变现的断批块位移永无人补偿（r7fixb 臂 6 个无写入位移帧）；
- rAF 注册序竞态：单 rAF 量测+补偿仍不够——探针/帧循环先注册先跑，会在补偿前采样到位移（r7fixb2 臂位移/补偿错开 1-3 帧）；
- 哨兵换块误量：补偿后重找「视口顶块」会在上方块变化后选到不同块，差值掺入块间距离（v3→v3.1 收敛 6→3 帧的修复点）。

## ③ 改动清单

| Fix | commit | 文件:行 | 内容 | 复杂度 | 回退开关 |
|---|---|---|---|---|---|
| **Fix-A demote 锁盒占位** | `c83f6a8` | `src/lib/lazyInlineMath.ts:458-505`（盒记忆双层：WeakMap+会话表 {w,h}）、`:522-553`（paintPlaceholder 锁盒 / clearLockbox）、`:576-582`（demote 量盒） | 占位锁盒复刻渲染态行内布局：`width+height 锁定 + overflow:hidden + vertical-align:bottom + max-width:none`，源码文本保留 DOM（查找/选区/复制语义不变），锁盒态仅存在于 IO 带外 800px+ | 时间 O(1)/条（demote 时一次 rect 量测，原已量高度），空间 O(min(公式数, 8192)) 会话表 | 无新开关——行为等价替换（回退 = revert commit） |
| **Fix-B 预热哨兵差值同帧补偿** | `2139144` | `src/lib/cvMemory.ts:696-714`（prewarmAnchorComp 纯函数：死区 1px/瞬移防护 3000px/限幅 ±8000）、`:875-913`（dispatch 前哨兵锚定 anchor0/anchorEl）、`:919-1000`（dispatch 后同任务强制布局量测+同帧补偿）、完成分支同款 | ①静态 upPhase 分段 → 哨兵差值（视口顶块 docTop 前后差，覆盖断批/混合批一切位移源）②双 rAF → 同步（dispatch 后同任务内强制布局+补偿，浏览器只 paint 最终态）③哨兵同块复测 ④prewarm-end 清场补偿 | 时间 O(批内块数) 量测（原已有）+ 每批 2 次 rect；空间 O(1) | 无新开关（补偿语义强化，回退 = revert commit） |

原型先行（§8 条款）：`perf/results/r7-phase5-proto-lockbox-{A,B,C}-proto*.json`——真实 dev 环境对视口内已渲染公式逐个替换为锁盒占位量段落块高差：变体 A（无校正）14/32 条 +2px；**变体 B/C（vertical-align:bottom）32/32 零差**——采纳 C（overflow:hidden 裁剪，无溢出重叠副作用）。未引入新调度/高度记忆算法（会话表为 R5 Fix-B 既有结构的维度扩展），1000 步随机编辑差分由 `incrementalSerializer.test.ts` 既有用例守卫（序列化不经 DOM，锁盒不影响文档语义）。

## ④ 门禁全表（基线 → 结果）

### D 组（漂移主门）

| # | 指标 | 基线（r7p2/r7p3） | 结果（r7fixa/r7fixb31/r7final） | 判定 |
|---|---|---|---|---|
| D1 ① | 位移 >4px 帧数（10s 窗） | 密度档 down-slow 21 / down-fast 6 / up-fast 6 / up-slow 6；1MB down-fast 72 / up-fast 69 | **密度档四场景全部 0**（0/1704、0/1622、0/1653、0/1645 复确认）；**1MB down-fast 3~9 / up-fast 3**（-87%~96%） | 密度档 ✅；1MB ⚠️ 未归零（见未达项归因） |
| D1 ② | 无输入程序化 scrollTop 写入 | 密度档 1-4、1MB 11-15（全 anchor-comp） | 密度档 **0**；1MB 1-3（prewarm-comp 同帧 1 + anchor-comp 兜底 1-2） | 密度档 ✅；1MB ⚠️（同帧同步化路线，按任务书 D2 允许非零、写入即补偿） |
| D1 ③ | MD-1001/1002 触发 | 0（全程） | **0**（全程，含 1MB） | ✅ |
| D2 | 静止期补偿计数（报告项） | 密度档 anchor.comp 4、1MB 14 | 密度档 **0**；1MB prewarm.comp 1（同帧）+ anchor.comp 1-2 | 路线判定：密度档走高度中性路线（趋 0 达成）；1MB 走同帧同步化路线（位移帧未全零，补偿即写入） |

**1MB 未达项归因（不许留空）**：残余 3~9 帧/10s 窗、单帧 8px 级 + 偶发 20-40px 格，集中在预热推进期窗尾。已消除：分段陈旧（12 格巨移）、断批无补偿、rAF 注册序竞态、哨兵换块误量、prewarm-end 清场回缩。剩余为 1MB 档 5fps 布局墙环境下强制布局量测与浏览器滚动应用的亚帧差（每 run 预热进度不同导致 3~9 波动；`死区 10px` 试图滤除反而劣化至 15 帧——中小批真实位移 10-40px 被放过，负结果已回滚留档）。进一步收敛需浏览器级 scroll/layout 同步性攻关，投入产出比低，**留档为 R8 候选**。等预热完成后的 10s 窗（r7p2b 口径）为全零——用户实际阅读场景（打开 ≥45s 后）已无漂移。

### M 组（完整性硬门，R6 沿承）

| # | 指标 | R6 收尾 | 本轮结果 | 判定 |
|---|---|---|---|---|
| M1 | 遍历往返+静止 10s 后视口/带内源码占位残留 | 0（三档） | **密度档 0 / 1MB 0 / 超限档 0**（vpUnready=0、bandUnready=0） | ✅ |
| M2 | 泵队列挂起 / 最老等待 | 0 | **queue=0 三档** | ✅ |
| M3 | 视口内块级公式挂载率 / katex-error | 100%（23/23）/ 0 | **100%（23/23）/ 0**（解题技巧_密度档，R6 同档口径） | ✅ |

> M3 口径勘误记录：本轮首次复测误用「无穷级数_密度档」（该 fixture 为纯行内公式文档，```latex 块数为 0——采到 latex=0 是正确结果而非回归）；R6 的 23/23 出自「解题技巧_密度档」。用正确 fixture 复测 23/23=100%，且 Fix-A/B 基线臂（checkout 9e0e4e9 源文件）与修复臂同值——**无回归**。katex-error 全程 0。

### T 组（及时性，不劣化 >10%）

| # | 指标 | R6 收尾 | 本轮（r7t，密度档 upscroll） | 判定 |
|---|---|---|---|---|
| T1 | 静止补绘拖尾（quietPhase 占位事件/p95） | events 0 / p95 0 | **events 0 / p95 0** | ✅ 持平 |
| T2 | 滚动中占位峰值 / 可见时长 p95 | peak 10 / durP95 38ms | **peak 10 / durP95 40ms（+5%）** | ✅ <10% |
| F 组 | stillOpen（残留）/ 滚动帧 p95 / MD 码 | 0 / 5ms / 0 | **0 / 6ms / 0** | ✅ 噪声级 |

### R 组（零回归，基线 R6 收尾同机）

| # | 指标 | R6 基线 | 本轮 | 判定 |
|---|---|---|---|---|
| R1 | 1MB 打开（3 轮中位） | 13,181ms | **11,466ms（-13%）** | ✅ |
| R2 | 打字 p95 密度档 / 1MB | 704ms / 424ms | **600ms（-15%）/ 400ms（-6%）** | ✅ |
| R3 | 切换中位（20 往返） | 2,255ms | **2,089ms（-3%）** | ✅ |
| R4 | 全量守卫 vitest | 978 | **986（+8 本轮用例）**；`test:coverage` 986 全绿、`lint` 零输出、`build`+`tauri build` 通过（Mditor_5.0.0-beta 安装包） | ✅ |
| R5 | 历轮门禁 | R6 收尾零复发 | **scroll-abab 1MB on ×3：p95 147.6~158ms（基线 208.5~212.6，-25~30%）、armValidated 全过；ghost-stress 5min：ghostSessions 11 / anomalies+0 与基线完全一致；md1011：见注** | ✅ |

> **md1011-verify 归因**（跑不了的按 §5 条款留档，不静默跳过）：该脚本在本轮环境两次挂死（with-dev 编排下 `cdp.eval` awaitPromise 无回执即永久挂起，日志停在命令启动行）；MD-1011 守卫由两层证据覆盖——①`md1011-regression.test.ts` 全绿（npm test 986 内）；②ghost-stress structural-tsunami 阶段（同类「AI 写入整批替换」场景）`block.rebase=0`（pm:rebuild 的姊妹计数器，R5 Fix 后既定零值）。本轮 Fix-A/B 均不触碰 pm:rebuild/装饰重建路径。
>
> **口径勘误**（防重走）：①scroll-abab 的 on 臂严格自证仅支持体量过线档（1MB）——密度档（密度旁路）on 臂必 FAIL（"不过线+on 但 host 带 data-big"），历轮 on 臂均用 1MB 档；`--doc 1MB` 会撞 `.pristine-1mb.md` 备份，须用 `--doc 1MB压测`；②M3 块级挂载探查须用「解题技巧_密度档」。

> R1/R2 首跑挂于 dev 实例启动竞争（CDP findPageTarget 超时），改 with-dev 编排器挂靠后通过——环境问题非代码回归。1MB 打开与打字反而更快：Fix-B 同步化把预热批布局从帧内挪回 idle 槽，滚动/打开主线程争用下降。

## ⑤ 遗留与放弃

**打包冒烟（prod-smoke，R7 口径）**：重建 `Mditor_5.0.0-beta_x64-setup.exe`（含 Fix-A/B）后实机断言——R6 项（行内公式 lazy 挂载 1,451/视口残留 0/`__mathPumpStats` 出口在打包 CSP 下可用）+ **R7 新增停滚漂移项**（滚动停止 + 420ms 静止门后 6s rAF 哨兵窗：360 帧位移 >4px 为 0、scrollTop 变化 0、程序化写入 0）——**PASS**（`perf/results/r7-prod-smoke.png`）。

- **1MB 档预热期残余 3~9 位移帧**：如上归因，R8 候选（浏览器级同步性/预热让路策略需用户拍板）。
- **P3 提案（预热批从 katexCache 渲染测高）**：本轮**未合入**（需用户拍板）。其靶（高度二象性 81px↔40px 瞬态、D-a 无预留冷条目首渲）已被 Fix-A 锁盒在 demote/重渲方向覆盖大半；**首渲方向**（占位→真身的宽度跳变必然有一帧）仍是无预留冷条目的固有窗口——密度档实测归零（首渲集中在滚动中带内，静止补绘窗内无上方冷条目），1MB up 场景偶发。若用户拍板 P3（打开后预热期把全文档公式渲染态盒尺寸学进会话表），首渲方向也可中性化——原型数据已具备（锁盒原型证明 {w,h} 记忆占位可行）。
- **D-c 打字机**：用户环境不触发，未改代码。留档：若未来开启打字机且报告「松手后页面反向拽」，查 `Editor.tsx:573-621` 的 400ms 静止门（迟发 selectionchange 可绕过）。
- **J-α''（R5 生产 +32s 未打标整千跳变）**：本轮生产日志复析未再捕获（现卷无 MD-1001），writeTrap 全程无未打标写入——未定罪维持，不并案。
- **负结果**（防重走）：死区 10px 补偿（劣化）；单 rAF 补偿（注册序竞态）；逐块 oldH 差值法（断批不完备）；变体 A 锁盒（+2px/条 baseline 偏差）。

## ⑥ 文档更新清单

- `CHANGELOG.md` Unreleased（2026-10-03 第七轮）
- `docs/performance.md`（补偿时序新参数）
- `memory/2026-10-03.md` + 本报告
