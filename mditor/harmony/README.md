# Mditor 鸿蒙（HarmonyOS PC）版

ArkWeb 混合壳：与 Windows 版共享同一份 React 前端（构建产物离线打进
`entry/src/main/resources/rawfile/web/`），文件/存储/弹窗能力经 JSBridge
走 ArkTS 原生实现。工程与 `../src-tauri/` 平级，全程命令行构建，不依赖
DevEco Studio。

## 构建

```bash
# 在 mditor/ 仓库根目录
npm run build:harmony
```

链路：`vite build --base ./`（相对路径是 ArkWeb rawfile 加载的唯一解）→
拷贝 `dist/` → `rawfile/web/` → `ohpm install` → `hvigorw assembleHap`。
产物：`harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`。

工具链要求（本机已装好，重装见 `~/Desktop/Tp/memory/2026-09-13.md`）：

| 项 | 要求 |
| --- | --- |
| Command Line Tools | 6.0.2.670（`C:\Huawei\command-line-tools\`，内嵌 API 22 SDK） |
| JDK 17 | 打包/签名需要（已装 Temurin 17 并 `setx JAVA_HOME`；脚本会自动探测） |
| ohpm | 随 CLT（官方源无需改） |

单独重打包（前端无变化时）：`cd harmony && hvigorw assembleHap --mode module -p product=default`。

## 签名与真机部署（待 AGC 调试证书）

未签名 HAP **不能直接安装**。两条路径：

### 路径 A（推荐，最省事）：DevEco Studio 自动签名

1. 安装 DevEco Studio，用华为开发者账号登录（`设置 → Sign In`）。
2. 打开本 `harmony/` 工程：`File → Project Structure → Signing Configs`，
   勾选 **Automatically generate signature**，选择设备（需开启开发者模式：
   设置 → 关于 → 连点版本号；`设置 → 系统 → 开发者选项 → USB 调试`）。
3. 重新 Build HAP——签名材料自动写入 `build-profile.json5` 的 signingConfigs。
4. `hdc install <签名后的 hap>` 或直接点 Run。

### 路径 B：AGC 手动申请 + hap-sign-tool

1. [AGC 控制台](https://developer.huawei.com/consumer/cn/agconnect/) →
   **我的项目** → 新建项目 → 添加应用（包名 `com.mditor.app`，上架前改正式名）。
2. **用户与访问 → 证书/Profile**：
   - 新建**调试证书**（上传 CSR，或用在线生成密钥对）→ 下载 `.cer`；
   - 新建**调试 Profile**（勾选调试设备——用 `hdc shell bm get --udid` 取设备
     UDID 添加）→ 下载 `.p7b`；
   - 记下密钥库文件 `.p12` 与密码。
3. 签名（hap-sign-tool 为 Java 实现，JDK 17 已就绪）：
   ```bash
   java -jar hap-sign-tool.jar sign-app -mode local-sign \
     -keyAlias <别名> -signAlg SHA256withECDSA \
     -profile <profile.p7b> -certPath <certificate.cer> \
     -inFile entry-default-unsigned.hap -keystoreFile <p12> \
     -signCertPath <certificate.cer> -outFile mditor-signed.hap \
     -profileSigned 1
   ```
4. 或在 `build-profile.json5` 的 `signingConfigs` 填入材料后 hvigor 直接出签名包。

### 安装到设备（MateBook / Mate 平板，HarmonyOS PC 形态）

```bash
hdc list targets                 # 确认设备在线（USB 或 WLAN 调试）
hdc install -r mditor-signed.hap # -r 覆盖安装（保留数据）
# 卸载：hdc uninstall com.mditor.app
```

日志排障：`hdc shell hilog | grep mditor`（前端 console 经 onConsole 看门狗
转发到原生日志，无需 DevTools）。

## MVP 能力矩阵

| 能力 | Windows 桌面版 | 鸿蒙 PC 版（MVP） |
| --- | --- | --- |
| 打开/编辑/保存 .md、工作区文件树 | ✅ | ✅（DocumentViewPicker + URI 权限持久化） |
| 三种编辑模式 / 大纲 / 主题 / 设置 / 最近文件 | ✅ | ✅ |
| HTML 导出 | ✅ | ✅ |
| 远程图片 | Rust 代理本地化 | ✅ webview 直连（无 CSP 限制） |
| 本地图片渲染 | asset:// | ✅ mditor-asset://（onInterceptRequest 供源） |
| AI 助手 / Agent / RAG | ✅ | ❌ 发送提示「暂不支持」（配置可保存；二期 ArkTS SSE 代理） |
| 多窗口多开 | ✅ | ❌ 单窗口（菜单已隐藏） |
| 外部修改监听（watch） | ✅ | ❌ 软降级不监听（索引靠保存/全量扫描） |
| 删除 | 回收站（可恢复） | 永久删除（确认弹窗已注明） |
| PDF / PNG / Word / LaTeX 导出 | ✅ | ❌ 菜单按能力隐藏，仅 HTML |
| 自绘窗口三键（最小化/最大化/关闭） | ✅ | 系统窗口管理接管（已隐藏） |

架构细节：虚拟路径（`/Docs/<token>` 工作区、`/AppData` 沙箱）由
`entry/src/main/ets/io/UriMapper.ets` 映射，权限过期统一 `E_PERMISSION`
错误码，前端引导重选工作区；桥协议两端实现（`bridge/Bridge.ets` ↔
`src/platform/harmony/bridge-client.ts`）改动需同步。

## 已知限制 / 待真机核验清单

- [ ] `fs.listFile` 对授权 URI 的目录遍历（PC 形态 + persistPermission 下
      预期可用；若失败，文件树为空并报 E_IO——需真机确认）
- [ ] `controller.postMessage` 端口投递的 `uri` 参数用 `'*'` 是否覆盖
      rawfile 加载（握手失败时前端 10s 内轮询补救）
- [ ] URI 上的 rename / mkdir / unlink 语义（工作区内新建/重命名/删除）
- [ ] AlertDialog 在桥回调上下文的展示（经主窗口 UIContext，预期正常）
- [ ] 关闭窗口收尾：先广播 `window-close-requested` 再 1.2s 后终止——
      preventDefault 不可用，脏缓冲依赖自动保存兜底（关前注意保存）
- [ ] hypium 本地单测（`entry/src/test/LocalUnit.test.ets`，5 用例）已随
      ohosTest 目标编译通过；CLI 无测试宿主，执行需 DevEco Studio 或真机
- [ ] 端到端联调：选工作区 → 文件树 → 打开 → 编辑 → 保存 → 重启恢复
      （最近文件/工作区虚拟路径经 uri-map.json 还原）

## 工程结构

```
harmony/
├── AppScope/app.json5                 # bundleName com.mditor.app（占位）
├── build-profile.json5                # product: default（6.0.2(22)）
└── entry/src/main/
    ├── module.json5                   # FILE_ACCESS_PERSIST + INTERNET，2in1
    ├── ets/
    │   ├── entryability/EntryAbility.ets   # 挂 HostContext + loadContent
    │   ├── pages/Index.ets            # ArkWeb 壳：注入引导/端口投递/console 看门狗/图片拦截
    │   ├── bridge/                    # Bridge(分发) Registry(注册表) DialogBridge HostContext
    │   ├── io/                        # UriMapper FileManager AssetResponder
    │   └── store/SettingsStore.ets    # filesDir/mditor.json（与桌面同格式）
    └── resources/rawfile/web/         # vite 产物（gitignore，脚本拷贝）
```
