# PROMPT：本地图片显示与公式渲染修复（第二轮 · 取证驱动）

> 背景：Mditor（Windows 桌面版，Tauri 2 + React + Milkdown/Crepe）第一轮修复已随
> v4.12.1 发布（NSIS 安装包），但用户反馈**问题仍在**：已有文档的本地图片不显示、
> `\(\)`/`\[\]` 定界的公式不渲染、公式位置显示红色报错。
> 你的任务不是重做第一轮——是先取证、锁定第一轮没覆盖的真实场景，再修。
> **铁律：取证完成前禁止改任何业务代码。** 盲修已经失败一轮，不允许第二轮盲修。

## 0. 第一步：向用户要这四样东西（缺一不可）

1. **一行图片引用原文**：从出问题的 .md 源文件里原样复制那行 `![](...)`（或 `<img>` 标签）。
2. **一行不渲染的公式原文**：从源文件原样复制（包括它前后的文字）。
3. **文档路径 + 图片实际位置**：文档在哪、图片文件实际在磁盘的哪个目录。
4. **截图**：裂图状态 / 公式区域的显示状态。

拿到后先做纸面分析：引用形态属于下面假设清单的哪一条。能锁定的直接进修复；
锁不定的进第 1 步现场取证。

## 1. 现场取证（用户不在场或纸面分析不定案时）

### 1.1 先确认用户跑的到底是哪个版本（高优先疑点！）

应用目前**没有任何可见版本号**（设置/状态栏/关于都没有）——用户可能一直跑的旧版。
- 让用户右键 Mditor 快捷方式 → 属性 → 详细信息 → 文件版本，**必须是 4.12.1**。
- 无论本轮修什么，都要顺手修掉这个盲区：**设置里加「关于：版本号」显示**
  （版本源 `src-tauri/tauri.conf.json` 的 version，带测试）。

### 1.2 DevTools 取证（release 包没开 devtools，必须用 dev 模式）

`npm run tauri dev`（Tauri 2 debug 构建自带 DevTools，Ctrl+Shift+I），打开**同一个文档**：

- **图片**：Elements 里找到裂图的 `<img>`，抄下 `src` 属性完整值。这个值直接定案：
  - src 是相对路径原样（没转换）→ proxyDomURL 没生效/表面不对；
  - src 是 `http://asset.localhost/<enc>` 且解码后**无盘符** → 根相对引用类（H1）；
  - src 解码后有盘符（`C%3A%2F...`）→ 拿解码路径去资源管理器验证文件是否真存在（H3）；
  - 根本没有 `<img>` → 文档里是别的写法（H2 原始 HTML / 语法没解析成图片）。
- **公式**：抄下红字里的 KaTeX 错误信息原文（`KaTeX parse error: ...`），
  这直接指出是哪条 LaTeX 出错（F1）还是根本没进 KaTeX（F2/F3）。
- **Console**：资源加载失败条目；`%APPDATA%/com.mditor.app/logs/memory.log` 里
  grep `MD-5012` / `res:load-fail`（现网异常通道，src/lib/devAnomaly.ts 定义）。

## 2. 已修复清单（v4.12.1 已包含——**不要重做**，但修新问题时不得回归）

- `src/lib/imageManager.ts:181` `resolveImgSrc`：先 `cleanLocalRef`（:131，剥
  `file://`、`?#`、percent 解码）→ 绝对/相对判定（相对按 docPath 拼接）→
  `normalizeLocalPath`（:151，归一 `./..`）→ `convertFileSrc`（异常回退原引用）。
- `src/hooks/useMilkdown.ts` `featureConfigs[ImageBlock].proxyDomURL` → 行内图片
  （crepe `image-inline` node view）与块级图片（`image-block` node view）**都**走它
  （已核实 @milkdown/components 源码，两个 node view 同构调 proxyDomURL）。
- CSP（`src-tauri/tauri.conf.json`）：`img-src 'self' asset: http://asset.localhost
  data: blob: https: http:`；assetProtocol scope `**`——**已验证不是 CSP 问题**。
- `src/lib/mathNormalize.ts`：`\(\)`/`\[\]` → `$`/`$$`（载入/AI 写回/静态渲染统一
  归一），含三类 markdown 转义误伤防护（`a\[1\]`、`\]`后跟`\(`、`]`前`\(`）。
- `src/lib/remarkMathGuard.ts` + `src/lib/mathLiveGuard.ts`：假公式（首尾空白 /
  闭 `$` 后跟数字，如 `$100，优惠 $50`、`$1-$10`）三层降级（remark 树层 /
  输入规则层 / PM appendTransaction 实时层）。
- crepe patch（`patches/@milkdown+crepe+7.22.1.patch`）：mathInlineInputRule 正则
  收紧（输入规则绕过 remark，键入层拦首尾空白公式体）+ 行内公式 toDOM 合并
  `katexOptions.macros`（自定义宏的行内公式不再 KaTeX 报错）。
- AI 写回 7 入口（aiWriteDoc/aiWriteRange/aiWriteInsert/aiWriteFinalize/
  insertAfter/insertValue/updateValue）过 `normalizeMathDelimiters`。
- 静态渲染管线（`src/lib/renderMarkdown.ts`，AI 面板/批注预览）同样接了
  normalize + remarkMathGuard。
- 测试基线：**vitest 720 全绿**；改完必须保持全绿并新增用例。

## 3. 假设清单（按概率排序；每条 = 取证特征 → 修法）

### 图片

- **H1 根相对引用 `/assets/x.png`**（Obsidian 风格工作区绝对路径）：
  特征 = img src 解码后是**无盘符**的 `/assets/...`（被当绝对路径直传
  convertFileSrc）。修法 = `resolveImgSrc` 对「`/` 开头 + 有 docPath」的引用
  重锚定到文档目录；注意 POSIX 上 `/...` 是真绝对路径，启发式只对 Windows
  盘符环境生效，用测试锁死两种平台语义。
- **H2 文档里是 `<img src="...">` 原始 HTML**（Notion/语雀导出常见）：
  特征 = 编辑器里根本没有 `<img>` 节点/或显示为文本。先查 Milkdown commonmark
  对 raw html 的解析行为，再决定：补 html→image 解析，还是明确告知不支持。
- **H3 图片文件真的不存在**（文档挪过目录 / assets 没跟着走）：
  特征 = src 的绝对路径在磁盘上不存在。修法 = 破图占位 UI（显示目标路径 +
  「重新选择/打开位置」），把静默裂图变成可操作的错误——这本身是价值修复。
- **H4 用户测的表面不是编辑器**（AI 面板/批注预览/HTML 导出）：
  特征 = 同一文档在编辑器里正常、面板/导出里裂。根因 = `renderMarkdown` 静态
  管线**不重写本地图片 src**。修法 = 静态管线对本地形态引用也走 `resolveImgSrc`
  （sanitize schema 允许 asset: 协议要一并确认）。
- **H5 文件名边角**：NFC/NFD、全角字符、`~` 家目录。低概率，取证兜底。

### 公式

- **F1 KaTeX 原生报错（红字 = 公式内容本身有问题）**：
  特征 = 红字里有具体 `KaTeX parse error`（Undefined control sequence 最常见
  ——用户在 Typora/Obsidian 配了宏而 Mditor 没有）。修法 = 按错误补默认宏 /
  引导用户在设置 mathMacros 配置；评估 `strict:false`、`trust:true`；错误提示
  本地化并显示原式。
- **F2 裸 LaTeX 环境无定界符**（`\begin{equation}...\end{equation}` 直接写在
  正文，AI 输出常见）：特征 = 源文件里根本没有 `$` 或 `\[`。修法 = 归一化层
  对「独立成行的裸环境」包 `$$`（务必谨慎：只处理块级独立成行形态 + 测试锁定，
  防止误伤普通文字里的 `\begin`）。
- **F3 误伤防护拦了真公式**：特征 = `\[` 前紧邻 ASCII 字母数字（如
  `E=mc^2\[...\]` 连排、`f(x)\[1\]`）。修法 = 细化 mathNormalize 防护 1：
  例如被拦截体内容含 `\` 命令或换行时视为真公式放行；必须有正反测试。
- **F4 公式在代码块/行内代码里**：by design 不渲染（保护演示性代码）。
  取证确认后向用户说明，不改。
- **F5 面板表面**：AI 面板已接 guard+normalize（已修清单），若红字只出现在
  面板，按红字信息走 F1 路径。

## 4. 验收与纪律

- 每个修复配测试（正反用例都锁）；`npm test`（720 基线 + 新增）、
  `tsc --noEmit`、`npx eslint src --max-warnings 0`、`npm run build` 全绿。
- 版本三处 bump（package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json；
  Cargo.lock 用 `NO_PROXY='*' no_proxy='*' cargo update -p mditor` 同步）；
  CHANGELOG 加条目；`NO_PROXY='*' no_proxy='*' npm run tauri build` 打包并让
  用户装新包复验（**在设置里能看到版本号**后再让用户验）。
- 本机系统代理 127.0.0.1:7890 常年失效，所有 cargo 命令带
  `NO_PROXY='*' no_proxy='*'`。
- 提交拆语义化 commit（修图片 / 修公式 / 版本+changelog 并入对应提交）；
  不动 `d1.jpeg`、`mditor/d2.jpeg`（用户杂散截图，保持未跟踪）。
- 修完把「取证结论 → 根因 → 修法」写进 `memory/YYYY-MM-DD.md`——本轮教训的
  核心就是第一轮没有取证就按推测修。

## 5. 不做清单

- 不重构平台适配层（src/platform/）、不动云同步代码（v4.12 刚落地）。
- 不给 KaTeX 换渲染引擎、不升级 milkdown 大版本。
- 不做图片代理/缓存新机制（远程图本地化已有）。
