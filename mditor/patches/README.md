# patch-package 补丁说明

本目录存放对第三方依赖的本地补丁（`postinstall` 钩子经 patch-package 自动应用）。
`npm install` 之后补丁即生效；若应用失败，npm 会在控制台红字提示。

## 现有补丁（5 个）

| 补丁 | 目标包 | 目的 |
|---|---|---|
| `@milkdown+components+7.22.1.patch` | @milkdown/components | 修复组件行为（详见补丁头注释） |
| `@milkdown+crepe+7.22.1.patch` | @milkdown/crepe | Crepe 主题/行为适配 |
| `@milkdown+plugin-listener+7.22.1.patch` | @milkdown/plugin-listener | 监听器时序修复 |
| `micromark-extension-math+3.1.0.patch` | micromark-extension-math | 数学定界符解析行为 |
| `prosemirror-virtual-cursor+0.4.2.patch` | prosemirror-virtual-cursor | 虚拟光标渲染 |

## 升级流程（改 patch 或升依赖时）

1. **改现有补丁**：编辑 `node_modules/<pkg>` 中的源文件 → 在 `mditor/` 下运行
   `npx patch-package <pkg>` → 提交更新后的 `.patch` 文件。
2. **升级被补丁的依赖**：`npm install <pkg>@new` → 补丁可能应用失败（hash 不匹配）。
   先看失败提示：小版本漂移可手改 `.patch` 头部的版本与 hash；语义变化大时，
   按上游新源码重新做修改再重新生成补丁。
3. **补丁不再需要**：删除 `.patch` 文件并 `npm install` 恢复原始包。
4. 提交信息里注明补丁动机与上游 issue 链接（若上游已修复，优先升级而非继续打补丁）。

## 红线

- 不要把补丁当功能分支用——补丁应保持最小、可解释、有移除路径。
- CI（`.github/workflows/ci.yml`）在干净安装后跑全量测试，补丁失效会直接红灯。
