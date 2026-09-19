# 贡献指南（Mditor）

Mditor 是 local-first 的 Markdown 编辑器（Tauri 2 + React 18 + Milkdown；Rust 后端；
HarmonyOS 移植在 `mditor/harmony/`）。本文覆盖构建、测试与发布纪律。

## 环境

- Node ≥ 22（`mditor/` 下 `npm ci`，postinstall 自动应用 patch-package 补丁）
- Rust stable（`mditor/src-tauri/`）
- Windows 构建桌面端；DevEco Studio / hvigorw 构建鸿蒙端（`npm run build:harmony`）

## 日常开发

```bash
cd mditor
npm run dev          # vite + tauri dev
npm test             # vitest（全部逻辑回归）
npm run lint         # eslint
npx tsc --noEmit     # 类型检查
```

Rust 侧：

```bash
cd mditor/src-tauri
cargo test
cargo clippy -- -D warnings   # CI 门禁标准，零警告
cargo fmt
```

## 提交前自查（CI 会强制，本地先跑省时间）

CI（`.github/workflows/ci.yml`）在 push / PR 上跑：`tsc + eslint + vitest +
SigV4 oracle + cargo fmt/clippy -D warnings/test`。release workflow 依赖
check 通过才允许发版——测试红了发不出包。

- 新增行为改动必须带回归测试（纯逻辑进 `src/lib/*.test.ts`；引擎级场景看
  `src/lib/sync/engine.test.ts` 的 IO 桩模式）。
- 故意吞掉的异常要留痕：注释原因 + `noteOpError`/`sysEmit`，或加可 grep 的
  `// silent:` 前缀。
- 密钥/凭据绝不进日志、不进仓库（本地签名口令一律走环境变量，见
  `scripts/sign-and-install.mjs`）。
- 签名口令传递方式与局限：hap-sign-tool 不支持口令文件/stdin（实测无
  `-keyPwdFile` 类参数，`-extCfgFile` 未接线），口令只能经 argv 传给 java
  进程——本机进程列表瞬时可见，仅可在可信机器上签名。脚本侧已兜底失败路径：
  `execFileSync` 抛错的 `message`/`stdout`/`stderr` 先把口令替换为 `******`
  再输出，避免明文进控制台/CI 日志。

## patch-package 纪律

第三方补丁在 `mditor/patches/`（5 个），升级/修改流程见
[`mditor/patches/README.md`](mditor/patches/README.md)。原则：补丁最小、
可解释、有移除路径；上游修复后优先升级。

## 发布流程

1. 版本号：`mditor/package.json`、`mditor/src-tauri/Cargo.toml`、
   `mditor/src-tauri/tauri.conf.json` 三处对齐（`npm run release:harmony`
   的校验器会查）。
2. CHANGELOG（`mditor/CHANGELOG.md`）补条目——根因级描述是本项目惯例。
3. 打 tag `v4.x.y` → release workflow 出 NSIS 安装包 + HAP；harmony job
   依赖 `vars.HARMONY_CLT_URL`（可选 `HARMONY_CLT_SHA256` 校验）。
4. 鸿蒙上架 runbook：`mditor/docs/`（AppGallery 发布链）。

## 仓库卫生

- 个人笔记/记忆文件（`memory/`、`MEMORY.md` 等）已取消跟踪，勿再提交。
- 游离截图等大文件不入库（`.gitignore` 已列显式路径）。
- CI 中第三方 action 一律固定 40 位 commit SHA，升级走 PR review。
