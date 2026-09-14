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
3. 签名（参数以 `java -jar hap-sign-tool.jar -h` 输出为准，下例已真机验证；
   提示词里常见的 `-mode local-sign`/`-profile`/`-certPath` 是错的，会报
   `11011005 Param is not trusted`）：
   ```bash
   java -jar hap-sign-tool.jar sign-app -mode localSign \
     -keyAlias <别名> -keyPwd <密钥密码> -signAlg SHA256withECDSA \
     -profileFile <profile.p7b> -appCertFile <certificate.cer> \
     -keystoreFile <keystore.p12> -keystorePwd <密钥库密码> \
     -profileSigned 1 -compatibleVersion 22 \
     -inFile entry-default-unsigned.hap -outFile mditor-signed.hap
   ```
4. 或直接用一键脚本 `node scripts/sign-and-install.mjs`（签名 + `hdc install -r`
   一步完成），或在 `build-profile.json5` 的 `signingConfigs` 填入材料后 hvigor
   直接出签名包。

### 路径 C：发布签名 + 上架 AppGallery

路径 A/B 只覆盖内测（debug 证书签的包仅 UDID 白名单设备可装）。公众分发需要
**发布证书 + 发布 Profile** 签 .app 包提交审核：材料清单、CSR/密钥生成、AGC
提审步骤与审核避坑见 [`docs/harmony-release.md`](../docs/harmony-release.md)，
一键出包 `npm run release:harmony`。

### 安装到设备（MateBook / Mate 平板，HarmonyOS PC 形态）

```bash
hdc list targets                 # 确认设备在线（USB 或 WLAN 调试）
hdc install -r mditor-signed.hap # -r 覆盖安装（保留数据）
# 卸载：hdc uninstall com.mditor.app
```

日志排障：`hdc shell hilog | grep mditor`（前端 console 经 onConsole 看门狗
转发到原生日志，无需 DevTools）。

## 能力矩阵（v4.13 P1-P7 补全后）

| 能力 | Windows 桌面版 | 鸿蒙 PC 版（v4.13） | 实现落点 |
| --- | --- | --- | --- |
| 打开/编辑/保存 .md、工作区文件树 | ✅ | ✅ | DocumentViewPicker + URI 权限持久化 |
| 三种编辑模式 / 大纲 / 主题 / 设置 / 最近文件 | ✅ | ✅ | — |
| HTML 导出 | ✅ | ✅ | — |
| LaTeX / DOCX / PNG 富导出 | ✅ | ✅（待真机验收） | 纯前端 exporter + 既有 fs/dialog 桥 |
| PDF 导出 | ✅ | ⏸ 待真机 spike：iframe print 能否唤起系统打印（不可用则维持隐藏，不做替代 hack） | `pdfExport` 能力位 |
| AI 助手 / Agent / RAG | ✅ | ✅（待真机验收） | `ets/ai/AiBridge.ets`（SSE 代理，契约对齐 ai.rs） |
| 云同步（S3 兼容） | ✅ | ✅（待真机验收） | `ets/net/S3Bridge.ets`（手写 SigV4，经 AWS SDK v3 签名器 20 向量核验，`node scripts/sigv4-check.mjs`） |
| 外部修改监听（watch） | ✅ notify | ✅ stat 轮询（待真机验收） | `ets/io/WatchManager.ets`（2s/5s 快照 diff；文件 mtime/size 对比，5000 条目上限） |
| 删除 | 系统回收站 | ✅ 应用回收站 `/AppData/trash`（30 天启动清理） | FileManager.trashFile + cleanupTrash |
| 多窗口多开 | ✅ | ❌ P6 spike 待真机（本轮无设备未执行，见下） | `multiWindow` 能力位保持 false |
| 远程图片 | Rust 代理本地化 | ✅ webview 直连（无 CSP 限制） | — |
| 本地图片渲染 | asset:// | ✅ mditor-asset://（onInterceptRequest 供源） | — |
| 自绘窗口三键（最小化/最大化/关闭） | ✅ | 系统窗口管理接管（已隐藏） | — |

统一接入模式：前端与桌面共用同一份 React 产物，每项能力 = 「ArkTS 桥按
Tauri 命令原名注册 method → `HARMONY_CAPS` 翻 true → 前端硬门控解除 →
断言单测重写」。桥协议/事件名/载荷与桌面逐字一致，前端业务代码
（ai.ts / sync 引擎 / exporter / agent / rag）零改动或仅改门控。

架构细节：虚拟路径（`/Docs/<token>` 工作区、`/AppData` 沙箱）由
`entry/src/main/ets/io/UriMapper.ets` 映射，权限过期统一 `E_PERMISSION`
错误码，前端引导重选工作区；桥协议两端实现（`bridge/Bridge.ets` ↔
`src/platform/harmony/bridge-client.ts`）改动需同步三处（含 Registry.ets
头注释）。二进制一律 base64（`{base64}` 形状，编解码实现全项目唯一）。

## 已知限制 / 待真机核验清单（v4.13）

> 本轮（2026-09-14）开发期间设备未连接（`hdc list targets` 为空）——
> 以下全部待真机执行；自动门禁（vitest 758 / tsc / eslint / assembleHap /
> sigv4-check 20 向量）已全绿。

**P0 冒烟（既有清单顺带核销）**
- [ ] `fs.listFile` 对授权 URI 的目录遍历；URI 上的 rename/mkdir/unlink
- [ ] 选工作区 → 文件树 → 打开 → 编辑 → 保存 → 重启恢复端到端
- [ ] 关窗收尾（window-close-requested → 1.2s → 终止）

**P1 导出**
- [ ] LaTeX .tex 内容正确；DOCX 设备 Office/WPS 可开（含图片内联）；
      PNG 存图库可看
- [ ] PDF spike：真机验证 iframe print 能否唤起系统打印 → 决定
      `pdfExport` 翻 true 或记录限制

**P2 AI**
- [ ] 设置「测试连接」；流式对话（含思考内容）；取消立即停止；
      选区工具/Agent 写文件；RAG 构建索引 + 全库问答
- [ ] 局域网 Ollama/LM Studio 明文 `http://` 连通性（若被鸿蒙明文流量
      策略拦截，查证 module.json5 明文配置并记录）

**P3 云同步**
- [ ] 测试连接（含错误凭证中文指引）→ 首同步（中文/空格文件名）→
      二次零操作 → 双端冲突副本 → 保存防抖自动同步 → 状态栏四态
- 提示：ArkTS 与桌面同规则——HTTP 仅放行 `localhost/127.0.0.1`。真机连
  局域网 MinIO 走 HTTPS；或用 `hdc rport <serial> local:<pcPort>
  remote:9000` 把设备侧 localhost 反转到 PC，endpoint 填
  `http://127.0.0.1:<pcPort>` 即落入放行例外

**P4 watch**
- [ ] 外部应用修改当前文档 → 「已从外部同步」/脏缓冲弹窗；文件树与
      vaultIndex（Ctrl+P、反链）增量刷新；大工作区轮询 CPU 可接受
- 实现说明：快照 diff 为全量 stat 对比（非目录 mtime 预筛）——外部编辑
  已有文件只改文件自身 mtime，目录预筛会漏掉主场景，属有意取舍

**P5 回收站**
- [ ] 删除文件/目录进 `/AppData/trash`；重启触发 30 天清理；
      Agent delete_note 走回收站

**P6 多窗口（spike 未执行——本轮无设备）**
两条候选路线，真机半天内出结论后再实施（双败则维持 `multiWindow=false`）：
1. **路线 A**：`window.createWindow(ctx, WINDOW_TYPE_APP)` 二级窗口 + 独立
   Web 组件（同假域名 src、独立 WebviewController + Bridge 端口对）——
   验证建窗/关窗/拖拽缩放、第二 Web 的 `__init_port__` 握手与 RPC 往返
2. **路线 B**：ability `launchType: "multiton"` + `startAbility`
   want.parameters（label/path/handoff），跨窗事件走 commonEventManager
   扇出到各 Bridge
实施要点（对齐桌面 commands.rs 契约）：`create_doc_window`/`stash_tab_payload`
（60s TTL 取即删）/`take_tab_payload` 三命令同名注册；label `doc-{n}` 单调
递增；大内容绝不进 URL（只 `?path=&handoff=` 短参数）；`app.emit` 扇出到
全部窗口；同步引擎装配按 `label==='main'` 门控。

## 工程结构

```
harmony/
├── AppScope/app.json5                 # bundleName com.mditor.app（v4.13）
├── build-profile.json5                # product: default（6.0.2(22)）
└── entry/src/main/
    ├── module.json5                   # FILE_ACCESS_PERSIST + INTERNET，2in1
    ├── ets/
    │   ├── entryability/EntryAbility.ets   # 挂 HostContext + 回收站启动清理 + loadContent
    │   ├── pages/Index.ets            # ArkWeb 壳：注入引导/端口投递/console 看门狗/图片拦截
    │   ├── bridge/                    # Bridge(分发+重载清理钩子) Registry DialogBridge HostContext
    │   ├── ai/AiBridge.ets            # AI 四命令（SSE 代理，契约对齐 ai.rs）
    │   ├── net/S3Bridge.ets           # S3 六命令（手写 SigV4 + ListObjectsV2 XML）
    │   ├── io/                        # UriMapper FileManager(+回收站) AssetResponder WatchManager
    │   └── store/SettingsStore.ets    # filesDir/mditor.json（与桌面同格式）
    └── resources/rawfile/web/         # vite 产物（gitignore，脚本拷贝）
```
