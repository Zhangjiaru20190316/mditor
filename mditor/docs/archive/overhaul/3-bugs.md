# 项目全面治理 · 阶段 3：Bug 清单

> 日期：2026-08-28 ｜ 修复提交：`5263225`（AI 流式取消 + 响应截断）、`370aad8`（测试伪象）
> 来源：阶段 0-2 暴露项 + CHANGELOG「已知问题」清单 + TODO 清查。
> 流程纪律：每项先复现/证伪 → 根因 → 最小修复 → 回归测试（能自动化的全部自动化）。

## 清单

| # | 标题 | 复现 | 根因 | 修复 | 回归测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| E | **AI 流式「停止」不停止计费** | 流式回答中点「停止」：前端立刻收尾（onDone），但 Rust 侧继续拉上游流到自然结束——被中止请求的 token 照常计费（CHANGELOG 旧轮「已知问题」实锤项） | `ai.ts` 的 `cancel()` 只做前端三件事（置标志/摘监听/本地 onDone），从不通知后端；`ai_chat_stream` 无任何取消通道 | Rust 新增 `ai_chat_cancel` 命令 + `CancelRegistry`（Drop 守卫兜住全部退出路径的条目清理，容量上限兜迟到取消）；流循环逐 chunk 检查、取消即停拉；前端 cancel() fire-and-forget 调用（旧后端静默降级） | Rust `cancel_registry` 2 例 + 前端 `chatStream cancel 接线` 1 例（mock invoke 断言 requestId） | ✅ 已修（`5263225`） |
| D | ai_chat 解析失败回显完整上游响应 | 配错 Base URL（指向非 OpenAI 兼容服务）→ 错误提示包含整段响应 HTML，无长度限制 | 该分支直接 `{text}` 插值，未走 `truncate_error_body`（`friendly_error` 已有的纪律） | 经 `truncate_error_body`（300 字符截断） | 行为随 E 的 Rust 提交；文案级改动，由既有 Rust 编译与测试覆盖 | ✅ 已修（`5263225` 内同文件顺带，提交说明已注明） |
| B | 测试期 `TextSelection endpoint … (list_item)` stderr 告警 | `npm run test` → blockCommands 列表互转用例打印该告警（阶段 0 基线即有，用例本身通过） | `mockView(doc, 2)`：光标位 2 是 paragraph 开标签处，TextSelection 端点落在 list_item（无 inline 内容）——**测试伪象**，真实编辑器选区永远在文本块内 | 用例 caretPos 2→3（文本位），注释记录位置算术与来源 | 该文件 7/7 绿 + stderr 消失（噪声原本可能掩盖真实告警） | ✅ 已修（`370aad8`） |
| A | 文档内搜索计数疑似恒 0 | 阶段 1 基准：224KB/1MB 文档搜「极限」计数显示 0 个 | **非 Bug——测量竞态**：计数任务 = 200ms 防抖 + 全文序列化（1MB 档实测 599ms），恰好在基准脚本 800ms 读点附近完成。dev 实例复验（`perf/verify-search-count.mjs`）：224KB 档 400ms 即达 267 个（grep 215 行含「极限」、267 为出现次数，两口径一致），此后稳定 | 无需修复 | 复验脚本入库（200ms 间隔轮询计数 3s 的完整时序） | ✅ 结案（不成立） |
| C | html-to-docx 对无 src 的 `<img>` 崩溃 | 阶段 1 探针以 live DOM innerHTML 为输入导出 DOCX → `TypeError: startsWith of undefined`（lib 内 `yM` 图片处理函数直接 `n2.startsWith`） | 库对 `<img src>` 缺失不设防。**真实导出路径不可达**：输入是 `ed.getHTML()`，milkdown image 节点 `src` 属性 `default: ""`——永远是非空字符串（可为空串，不可为 undefined） | 无需修复（探针伪象；空串路径走库内跳过逻辑） | 已核验 schema 定义（preset-commonmark imageSchema） | ✅ 结案（不可达） |

## 已知问题清单复核（CHANGELOG 旧轮「本轮未修」项）

| 项 | 现状 |
| --- | --- |
| npm audit image-size 2 高危 | ✅ 阶段 2 已修（导出内联魔数门，`dfb0d89`） |
| 渲染管线 ~500KB 实际打进主 bundle（注释称懒加载） | 阶段 1 已测冷启动 0 长任务（冷盘 DCL 755ms）——不构成性能问题；「注释与实现不符」转阶段 4 文档校正 |
| AI 流式停止不停止计费 | ✅ 本轮 Bug E 已修 |
| fs scope `**` / API key 明文 | 既有文档化产品取舍，阶段 2 维持（docs/security.md 有完整论证） |

## 验证

`npm run test` **377/377**（376 + AI cancel 新用例）；`cargo test` 6/6；`tsc --noEmit` / 改动文件 ESLint / `cargo clippy`（持平基线 6 条）全绿；`npm run build` 11.5s 通过。回滚：两笔提交各自独立可 revert。
