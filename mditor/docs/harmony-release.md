# 鸿蒙版上架华为应用市场（AppGallery）Runbook

> 目标：把 Mditor 鸿蒙端（`harmony/`）以**发布签名**正式上架华为应用市场。
> 内测（debug 签名 + 真机部署）路径见 [harmony/README.md](../harmony/README.md)「签名与真机部署」，本篇是它的上架延伸。
>
> **状态（2026-09-14）**：构建与签名脚本已就绪并验证（`npm run release:harmony -- --build-only` 实测通过）；上架操作卡在需要你手动完成的 AGC 网页步骤（§2–§4）与合规材料（§5）。每完成一节就把 ☐ 勾上。

## 0. 总览

```
[一次性] AGC 实名认证 → 生成发布密钥对+CSR → 申请发布证书 → 创建发布 Profile
[合规]   隐私政策 URL（已就绪）→ ICP 备案（中国大陆区需要）→ 图标/截图/简介
[每次]   npm run build:harmony → npm run release:harmony → AGC 上传 .app → 提交审核
```

**关键概念**：上架上传的是 **.app 包**（应用包，内含 HAP），必须用**发布证书 + 发布 Profile** 签名；debug 签名包 AGC 直接拒收。发布 Profile 不含设备 UDID，签出的包可装任何设备——所以发布密钥材料**绝不能提交进仓库**（`harmony/.gitignore` 已覆盖 `signing/`）。

## 1. 已就绪的现状（不用重做）

| 事项 | 状态 |
| --- | --- |
| AGC 开发者账号 | ✅ 已注册并登录过（张家润），项目 `mditor` |
| APP ID | ✅ `com.mditor.app`（应用名 Mditor）已注册 |
| 调试证书/Profile | ✅ 内测用，2027-09-13 到期，与上架无关 |
| 构建链 | ✅ CLT 6.0.2.670（API 22）+ JDK 17，`npm run build:harmony` 一键出包 |
| 出包脚本 | ✅ `npm run release:harmony`（`scripts/release-harmony.mjs`） |
| 隐私政策 URL | ✅ <https://zhangjiaru20190316.github.io/mditor/privacy.html>（推到 main 后自动生效） |

## 2. AGC 发布证书（一次性，约 20 分钟）

1. **确认实名认证**：[AGC](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html) → 账号中心 → 实名认证。个人开发者免费，接受个人身份认证即可（上架「个人开发者」应用）。
2. **生成发布密钥对 + CSR**（本机，`harmony/signing/` 下执行；参数已对照 hap-sign-tool 6.x `-h` 核验）：

   ```bash
   cd mditor/harmony/signing
   JAR="/c/Huawei/command-line-tools/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar"
   JAVA="/c/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot/bin/java.exe"

   # ① 密钥库（密码自己定，妥善保管；丢了无法补，只能换证书重签名）
   "$JAVA" -jar "$JAR" generate-keypair \
     -keyAlias "mditor-release" -keyAlg ECC -keySize NIST-P-256 \
     -keystoreFile "mditor-release.p12" -keystorePwd "<你的发布密码>"

   # ② CSR（-subject 必填；-outFile 落盘，缺了会打到控制台）
   "$JAVA" -jar "$JAR" generate-csr \
     -keyAlias "mditor-release" -keyPwd "<你的发布密码>" \
     -subject "C=CN, O=mditor, CN=Mditor Release" \
     -signAlg "SHA256withECDSA" \
     -keystoreFile "mditor-release.p12" -keystorePwd "<你的发布密码>" \
     -outFile "mditor-release.csr"
   ```

3. **申请发布证书**：AGC → 证书、APP ID 与 Profile → 证书 → 新增证书 → 类型选 **发布证书** → 上传 `mditor-release.csr` → 下载得到 `mditor-release.cer`，放进 `harmony/signing/`。
   ⚠️ **每个账号限 1 张发布证书**（HarmonyOS NEXT 规则），有效期最长 3 年；到期/吊销后需重新申请并**全量重签名**。
4. **创建发布 Profile**：同页 → HarmonyOS Profile → 新增 → 选择应用 `com.mditor.app` → 类型 **发布** → 关联刚申请的发布证书 → 下载得到 `release.p7b`，放进 `harmony/signing/`。
5. **本机导出环境变量**（不写入任何文件入库）：

   ```bash
   export MDITOR_RELEASE_KEYSTORE_PWD="<你的发布密码>"
   ```

## 3. 合规材料（上架中国大陆区的门槛，重点）

| 材料 | 要求 | 状态 |
| --- | --- | --- |
| 隐私政策 URL | 公网可访问，内容与实际权限/联网行为一致 | ✅ site/privacy.html（页脚已挂入口） |
| **ICP 备案号** | 2023 年起工信部要求：中国大陆区上架**联网应用**须填写 App 备案号 | ☐ 见下方说明，最大不确定点 |
| 软件著作权 | 部分类目提审时要求；工具/效率类个人开发者通常不强制 | ☐ 以 AGC 提审表单实际提示为准 |
| 应用图标 | 216×216 PNG，无圆角无透明边（系统自动裁切） | ☐ 可从 `mditor/src-tauri/icons/` 派生 |
| 截图/视频 | 每个 deviceType 至少 3 张（default=手机/平板、2in1=PC 形态）；MatePad Edge 已有一批在 `harmony/signing/`（gitignore） | ☐ 上架前跑 P0 冒烟后重截 |
| 应用简介/版本说明 | 简介 + 新版本特性描述，不能出现"测试/Beta"字样 | ☐ |
| 类目/标签 | 建议：效率 → 笔记/文档 | ☐ |

**ICP 备案怎么办**：

- 路径：需要一个域名 + 一台国内云服务器（阿里云/腾讯云/华为云均可），在云服务商备案系统提交**个人备案**（网站/<App 备案），省通信管理局审核约 1–4 周，之后在 AGC 提审时填入备案号。
- 判断：Mditor 有 AI / 云同步联网功能，属联网应用，中国大陆区绕不开。
- **兜底方案（若不想办备案）**：① 走 **AppGallery 海外区**上架（不需 ICP 备案，但应用资料需英文、面向海外用户，AI 功能话术同样适用）；② 维持现状——GitHub Release 挂 debug 签名内测包（仅 UDID 白名单设备可装），把上架推迟。

## 4. 构建签名出包（每次发版执行）

```bash
cd mditor
export MDITOR_RELEASE_KEYSTORE_PWD="<你的发布密码>"   # 签名步骤才需要

# ① 刷新 rawfile/web 前端产物（release 脚本不重建前端）
npm run build:harmony

# ② assembleApp + 发布签名 → harmony/signing/Mditor_<版本>_harmony-release.app
npm run release:harmony
#    还没申请证书时可先验证构建：npm run release:harmony -- --build-only
```

脚本行为（`scripts/release-harmony.mjs`）：

1. `hvigorw assembleApp --mode project -p product=default -p buildMode=release`（`assembleApp` 是项目级任务，产物在 `harmony/build/outputs/default/harmony-default-unsigned.app`——不是 entry 模块目录，别找错）；
2. `hap-sign-tool sign-app` 发布签名，参数与 debug 流程同款（`-mode localSign -profileSigned 1 -compatibleVersion 22`，已真机验证）；
3. 产物命名 `Mditor_<versionName>_harmony-release.app`，versionName 自动读自 `AppScope/app.json5`。

CI（`.github/workflows/release.yml` 的 `harmony` job）会在打 tag 时自动构建 **unsigned** HAP 挂到 Release——那只是构建产物存档，上架包一律用上面 ② 的本机签名 .app。首次启用 CI 需在仓库 Settings → Secrets and variables → Actions → Variables 配置 `HARMONY_CLT_URL`（HarmonyOS Command-Line Tools zip 的直链；官网下载要登录，自己传到可直连的地方），未配置时该 job 自动跳过。

### 发版前检查：桥协议三方核对（本版动过桥命令则必做）

桥协议散落三处，任一处单独改动即产生代码-文档漂移。历史实案两次：v4.16.0 N16 改关窗协议后 `harmony/README.md` 的「1.2s 盲等」描述过期（第四批审计发现后修正）；同批 P6 给 S3Bridge 增 `s3_get_file`/`s3_put_file` 后 README「工程结构」树的「S3 六命令」计数过期（第五批首次核对发现）。快速判据：本版 `git log` 触及 `harmony/entry/src/main/ets/`（bridge/ai/net/io）或 `mditor/src/platform/` 即须核对。

| 方 | 位置 | 核对什么 |
| --- | --- | --- |
| ① 注册表 | `harmony/entry/src/main/ets/bridge/Registry.ets` 直注 + `ai/AiBridge.ets`、`net/S3Bridge.ets`、`io/WatchManager.ets` 各自 `registerAll()` 的委托注册 | 注册命令名全集、参数/返回形状、事件名 |
| ② 前端接口 | `src/platform/types.ts`（PlatformFs/Dialog/Store/Window/App 签名）+ `src/platform/harmony/index.ts` 适配器 + `src/lib`、`App.tsx` 里 `app.invoke` 直通调用（`fs.syncName`、`ai_*`、`s3_*`） | ① 每条命令都有调用点；签名变更两端同步（先例：`onCloseRequested` 为 N16 ack 放宽为 `void \| false \| Promise<void \| false>`） |
| ③ 文档 | `harmony/README.md`（能力矩阵 / 已知限制 / 工程结构树的命令计数与协议描述）+ Registry.ets 头注释 | 文中命令数、协议语义（ack / 超时 / 轮询参数）与 ① 当前实现一致 |

核对命令（Git Bash，在 `mditor/` 下执行；①↔② 清单 diff，③ 人工比对）：

```bash
# ① 注册表命令清单（2026-09-21 基线 45 条：fs 13 / dialog 5 / store 4 / app 11 / ai 4 / s3 8）
grep -rhoE "register\('[^']+'" harmony/entry/src/main/ets --include="*.ets" \
  | sed "s/register('//;s/'$//" | sort

# ② 前端调用侧清单（具名适配器 + invoke 直通；跨行调用会漏，用下面的兜底补）
grep -rhoE 'bridge\.request[^"]*"[^"]+"' src/platform/harmony --include="*.ts" | grep -oE '"[^"]+"' | tr -d '"' | sort -u
grep -rhoE 'invoke[^"]*"[a-z_0-9]+"' src/lib src/App.tsx --include="*.ts" --include="*.tsx" \
  | grep -oE '"[a-z_0-9]+"' | tr -d '"' | grep -E '^(fs|app|ai|s3)\.' | sort -u

# 兜底（孤儿检查）：① 中每条命令反查 src/ 调用点——跨行 invoke 在此命中；输出「无前端调用」= 死注册
for c in $(grep -rhoE "register\('[^']+'" harmony/entry/src/main/ets --include="*.ets" | sed "s/register('//;s/'$//"); do \
  grep -rlq "\"$c\"" src --include="*.ts" --include="*.tsx" || echo "无前端调用: $c"; done
```

判读：①↔② 应一一对应——② 多出的命令须为桌面 Tauri 专属、鸿蒙分支不触达（如 `s3_download_file`）；兜底输出孤儿即死注册。③ 与 ① 不一致 = 文档漂移，**就地修正 README / Registry 头注释后再出包**。

> 2026-09-21 首次核对记录（本清单随第五批建立时执行）：①↔② 一致（45 条全部有调用点、无孤儿；`s3_download_file` 为桌面专属合规多出）；③ 发现 1 处漂移——`harmony/README.md:180`「S3 六命令」实际为 8 条（v4.16.0 P6 增两条文件通道命令后未同步），另见当批任务报告。

## 5. AGC 上传与提审

1. AGC → 我的应用 → **Mditor**（`com.mditor.app`）→ **版本管理（HarmonyOS）**。
2. 「软件包」上传 `Mditor_x.y.z_harmony-release.app`，等待系统自动校验（验签、包名、版本一致性，几分钟）。
3. 填写版本信息（版本说明）+ 应用信息核对（图标/截图/类目/隐私政策 URL/备案号）。
4. **提审备注（避坑关键）**建议原文粘贴：
   > 本应用为本地优先 Markdown 编辑器，核心编辑功能完全离线可用，无需注册登录任何账号。AI 助手与云同步为可选功能，由用户自行配置自己的服务地址与密钥（如本地 Ollama、自建 S3），应用官方无任何服务器。审核测试时可直接编辑/保存 Markdown 文件验证核心功能；如需验证 AI 功能，可在设置 → AI 中填入任意 OpenAI 兼容端点。
5. 提交审核。周期通常 1–3 个工作日；被拒会给出原因，修完重新走 §4 + §5（版本号不变、versionCode 不变可重新上传同版本修正包；若改了代码则 versionCode 必须递增）。
6. 审核通过后选择发布策略：**全量发布**，或先用**分阶段发布**（按比例放量）观察崩溃率。

## 6. 上架后的版本更新（复用 §4–§5）

发版四件套（`package.json` / `Cargo.toml` / `tauri.conf.json` / `AppScope/app.json5` + `Cargo.lock`）→ CHANGELOG → `chore(release)` 提交 → 打 tag `vX.Y.Z`（触发 Windows CI + 鸿蒙 unsigned HAP）→ 本机 `npm run release:harmony` → AGC「新版本」上传提审。**versionCode 规则：1000000 + 次版本×100 + 修订号**（如 4.13.0 → 1001300），只增不减。

## 7. 常见报错速查

| 报错 | 原因/解法 |
| --- | --- |
| `Task 'assembleApp' was not found`（00306054） | 用了 `--mode module`；`assembleApp` 必须项目级：`--mode project` |
| `Param is not trusted`（11011005） | hap-sign-tool 参数名不在白名单；以 `java -jar hap-sign-tool.jar -h` 输出为准（如 `generate-csr` 用 `-outFile` 不是 `-csrFile`，且 `-subject`/`-signAlg` 必填） |
| AGC 上传报未签名/签名无效 | 上传了 unsigned 或 debug 签名的包；AGC 只收发布证书 + 发布 Profile 签的 .app |
| `缺少发布签名材料…`（脚本） | 材料没齐或文件名不符：`harmony/signing/mditor-release.p12/.cer`、`release.p7b`；只想先出包加 `--build-only` |
| `缺少环境变量 MDITOR_RELEASE_KEYSTORE_PWD` | 发布密码走环境变量，不入库 |
