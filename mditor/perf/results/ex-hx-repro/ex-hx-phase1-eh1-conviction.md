# HX 阶段一 E-H1 定罪结论（症状：导出 HTML 浏览器打开后无法滚动）

日期：2026-10-17 · HEAD `3660e93`（5.0.2-beta 同源）· 取证环境：dev 实例（CDP 9223，identifier 覆盖隔离）+ Edge headless（Chromium）

## 结论（唯一根因，S-H1 收敛）

**应用外壳规则 `body { overflow: hidden }`（src/styles/global.css:125-134）随 collectThemeCss 整包收集进入导出文件，
在独立 HTML 中命中 `<body class="vditor-reset">`；因根元素 overflow 为 visible，按 CSS Overflow §3 该声明传播到视口，
用户滚动（滚轮/键盘/拖条）被锁死——内容在流底 1905px、视口 804px，视口以下不可见。**
伴随条件 `html, body, #root { height: 100% }`（global.css:117-123）同路进入但单独不致瘫（实验 B）。
wrapHtml 导出外壳 defaults（exporter.ts:375-382）未声明任何 `overflow`/`height`，层叠上盖不掉。

## 判别实验与对照（ex-hx-html-browser.json，两轮一致 = 复现 ≥2 次稳定）

| 实验 | 注入覆盖 | 用户滚轮 ×5(600px) 后 scrollY | 判定 |
|---|---|---|---|
| 基线（导出文件原样） | — | **0（锁死）** | E-H1 复现 ✓ |
| A 只解 `body{overflow:visible}` | overflow 覆盖 | 1101（= 1905−804 滚到底） | overflow:hidden 是致瘫声明 |
| B 只解 `html,body{height:auto}` | height 覆盖 | **0（仍锁死）** | height:100% 单独不致瘫 |
| 再锁定（移除注入） | — | **0（恢复锁死）** | 因果闭环 ✓ |
| C 双解（候选修复语义） | height+overflow | 1141（滚到底） | 修复方向有效 |

测量口径：scrollTo 对 overflow:hidden 视口也能编程滚动（hidden 盒可编程滚动），故以 CDP 受信任滚轮/键盘事件为准。

## 嫌疑逐项排除

- **S-H4 文件截断**：排除。961,077 字节、尾部 `</html>` 闭合、首标题（`<h1 id="科研功能验收样例">`）与末可见文本（「导出时替换为正式列表」）均完整（ex-hx-html-evidence.json）。
- **S-H2 整包 CSS 其他外壳副作用**：排除。S-H2 审计（同 json `s2_audit`）：布局影响声明且命中本文档元素的规则共 40 条，其中 38 条为 KaTeX 内部规则（公式渲染必需，scoped `.katex` 子树）、`.wikilink-unresolved` padding（无害）、wrapHtml 自身 defaults（预期）；`.app` 网格 / `position:fixed` 浮层 / `#root` / `body.is-resizing` 等 shell 选择器在裸文档零命中。
- **S-H3 wrapHtml 模板自身缺陷**：排除（作为独立根因）。模板结构与 defaults 渲染正确、主题保真（data-theme 回写 + var 背景）；其唯一缺陷是「未声明 overflow/height 覆盖」——即 S-H1 机制的层叠面，不是独立缺陷。

## git 考古（回归引入点）

**无回归引入点——先天缺陷，引入 commit = init `226b807`（2026-08-14，Mditor 3.4.0）**：

1. `226b807:src/styles/global.css` 已含 `html,body,#root{height:100%}`（:17-23）与 `body{...overflow:hidden...}`（:25-31）；
2. `226b807:src/App.tsx:1239-1266` 的 collectThemeCss 与现行 themeCss.ts 逐字同义（href 空/含 /assets/ 全收，零过滤）；
3. `226b807:src/lib/exporter.ts` exportHtml/wrapHtml 在位，defaults 同样无 overflow/height；
4. `git log -S "overflow" -- src/lib/exporter.ts` 全历史为空——导出侧从未有过覆盖。

**为何现在才报障**：HTML 导出功能自出生即坏，此前无用户报障记录；2026-09~10 用户工作流以 PDF/DOCX 为主（EX/DX 两轮全在 PDF/DOCX 域），5.0.2-beta 导出体系翻新后用户首次实际使用「导出 HTML」，先天缺陷随即暴露。memory/2026-09-18 的白纸白字修复（data-theme 回写）只修了主题保真面，未触及 overflow 面。

## 复现链忠实性声明

页内复刻链调用的是与生产同源的真源模块（getHTML → renderBlockMath/双链/引用/闪卡降级 → collectThemeCss →
sanitizeExportHtml → inlineKatexFonts → wrapHtml），与 doExport→exportHtml 唯一差异：不经 pickSaveFile 原生对话框、
inlineImages=false（内联图片仅改 img src，与滚动锁死无关）。见 perf/ex-hx-html-repro.mjs。

## 修复方向（阶段二执行，候选 C 语义）

wrapHtml defaults 增加导出外壳覆盖 `html, body { height: auto; overflow: visible; }`——仅动 HTML 落盘外壳，
不触碰 global.css（红线 5）、不触碰 collectThemeCss 共享件（红线 6 无须请示）。
