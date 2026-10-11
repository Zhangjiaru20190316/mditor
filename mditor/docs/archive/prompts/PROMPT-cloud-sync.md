# Mditor 云同步功能 · 一次性开发提示词

> 使用方式：将本文档全文作为唯一任务指令交给开发代理（全新会话）。代理应在 `mditor/` 目录内工作。本文档自包含所有必要背景；实现中遇到本文未覆盖的细节，遵循 §1 的项目惯例；仍无法判断时选保守方案并在代码注释中标注 `SYNC-TODO`。

---

## 0. 任务一句话

为 Mditor 新增**可选的、用户自带存储的云同步**：把工作区目录双向同步到用户自有的 **S3 协议兼容第三方对象存储**（七牛云 Kodo、阿里云 OSS、Cloudflare R2、MinIO/自建、AWS S3、任意自定义 S3 兼容端点）。

**核心定位约束**：Mditor 的卖点是无云端、无遥测、本地优先。云同步必须设计为——默认关闭、纯可选、用户自己的桶自己的密钥（BYO storage）、不引入任何厂商绑定或中转服务。完成后项目定位表述从「无云端」调整为「默认无云端，可选自带 S3 兼容云同步」。

---

## 1. 项目背景与关键现状（必读，已核实）

Mditor：本地优先 Markdown 编辑器，对标 Typora。当前版本 4.10.0-beta.2（package.json / Cargo.toml / tauri.conf.json 三处版本需同步维护）。

| 领域 | 现状 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + Milkdown(Crepe)。无 i18n 框架（UI 文案硬编码中文）；无全局状态库（React hooks + 自有 lib 层） |
| 后端 | Tauri 2（Rust）。命令在 `src-tauri/src/commands.rs` 与 `src-tauri/src/ai.rs`，统一在 `src-tauri/src/lib.rs` 的 `invoke_handler` 注册 |
| 设置持久化 | `src/lib/store.ts` → plugin-store → app-data 下 `mditor.json`（键：settings / recent / workspaces / recentWorkspaces）。类型与默认值在 `src/types.ts`（`Settings` + `DEFAULT_SETTINGS` + `migrateSettings` 幂等迁移） |
| 网络安全模型 | webview CSP `connect-src 'self' ipc:` **禁止前端直连外网**；一切出网请求必须经 Rust 命令代理。先例：`commands.rs` 的 `fetch_image`（含 `MAX_IMAGE_BYTES` 硬上限与 30s 超时）；AI 功能复用 `reqwest`(rustls) 共享客户端 `crate::ai::http()` |
| 平台适配层 | `src/platform/`：运行时检测 tauri/harmony/browser，业务代码只经 `getAdapter()`；不支持的特性抛 `UnsupportedError`（`src/platform/errors.ts`） |
| 多窗口 (v4.8) | 每窗口 = 独立 webview = 完整 App 实例。窗口 label：`main` / `doc-{n}`（main 由 tauri.conf.json 静态定义）。跨窗口广播已有先例：`store.ts` 保存后 `emit("settings-changed")` 各窗幂等重载 |
| 工作区 | 多根：`workspaces: string[]`（`src/lib/workspaces.ts`） |
| 诊断体系 | `src/lib/diagnostics.ts` 事件总线；`src/lib/devAnomaly.ts` 按 MD-XXXX 错误码归类异常。**密钥绝不能进日志** |
| 文件链路 | 打开/保存：`src/lib/tauriFs.ts`（openMd/saveMd/saveMdAs，经适配层）；自动保存 hook：`src/hooks/useAutosave.ts`；外部变更监听：`src/hooks/useFileWatcher.ts` |
| 测试/构建 | vitest，`*.test.ts` 与源码同目录（`npm test`）；`npm run build` = tsc --noEmit && vite build；Rust `cargo check`；鸿蒙 `npm run build:harmony-web` |

惯例要求：新代码风格（中文注释说明「为什么」）、错误消息面向用户的中文、防御式校验（参照 `commands.rs` 中 `is_log_path_confined` 拒绝 `..` 的写法与注释风格）。

---

## 2. 范围

### v1 必须包含
1. 设置界面「云同步」分区：服务商预设、endpoint / region / bucket / AccessKey / SecretKey / 前缀 / 寻址风格、**测试连接**按钮
2. 双向同步引擎：文件级 3-way 合并（§5），冲突产生 `.冲突-时间戳` 副本，删除可传播（本地删除入回收站）
3. 手动「立即同步」+ 自动同步（保存后防抖、定时、启动时）
4. 状态栏同步指示器（多窗口一致）+ 同步状态事件广播
5. 本地同步清单（manifest）与回收站，全部存 app-data，**不在工作区落任何状态文件**
6. 诊断集成（错误码）+ vitest 单测（矩阵全覆盖）
7. README 更新（功能特性 + 安全模型）
8. **鸿蒙运行时兼容降级**（§7.5，属于交付范围而非"不做"）：模块层运行时守卫（抛 `UnsupportedError`）+ 全部 UI 禁用态/隐藏 + 引擎零装配 + `build:harmony-web` 编译不回归 + 对应 vitest 单测

### v1 明确不做（禁止顺手实现）
- 实时协同编辑、行级合并、同步 diff UI
- 端到端加密、OS keychain 托管密钥
- 自定义忽略规则编辑器（仅内置固定规则）
- 历史版本浏览（只在 UI 建议用户开启桶版本控制）
- 鸿蒙端**同步功能本体**（引擎装配、自动触发、任何真实 S3 调用——鸿蒙构建是 ArkTS 壳 + 纯 web 包，无 Tauri Rust 侧，`invoke` 命令天然不存在）。注意区分：本体的降级处理（守卫/禁用态/构建保障）**必须实现**，见 §7.5
- 新增快捷键（避免与现有键位冲突）

---

## 3. 已定架构决策（不得偏离）

- **D1 · S3 客户端在 Rust 侧，用 `object_store` crate**（最新稳定版，`default-features = false, features = ["aws"]`）。理由：CSP 禁止前端直连；SigV4 签名正确性（尤其中文/空格文件名的 canonical URI 编码）交给久经考验的实现。
  - 备选（仅当评估认为 object_store 依赖树过重时）：基于现有 reqwest 手写最小 SigV4（PUT/GET/HEAD/DELETE/ListObjectsV2 五个操作），**必须**附 AWS 官方 SigV4 测试向量单测 + 中文键名/空格/`+` 号编码用例。
  - 禁止：`aws-sdk-s3`（依赖树与二进制体积不可接受，与 Cargo.toml 中最小依赖哲学冲突）。
- **D2 · 分层**：Rust 只提供无状态 S3 原语命令；同步算法（扫描、清单、3-way 矩阵、冲突策略）全部在前端 `src/lib/sync/`。与项目「前端编排、Rust 做 IO」模式一致（参照 imageManager.ts + fetch_image 的分工）。
- **D3 · 配置随调用传入**：每个 Rust 命令接收完整 S3Config（含 AK/SK），不在 Rust 侧缓存/持久化。与 AI 命令按调用传 apiKey 的模式一致。
- **D4 · 密钥明文存 mditor.json**（与 aiApiKey 既有惯例一致），设置界面必须明示「密钥以明文保存在本机 mditor.json，建议使用仅限该桶的最小权限子账号」。
- **D5 · 同步单位**：工作区根目录 ↔ 桶内前缀。一份全局 S3 配置；每个根同步到 `<prefix>/<根目录名>/`（默认 prefix 为 `mditor/`）。多根工作区逐根独立同步。
- **D6 · 传输约束**：仅 HTTPS；例外：endpoint 为 `localhost/127.0.0.1` 时允许 HTTP（供 MinIO 本地调试，UI 显示警告，非 localhost 的 HTTP endpoint 保存时阻断）。单文件 ≤ 50MB（超限跳过并告警）；所有请求 30s 超时；上传/下载并发 ≤ 3；ListObjectsV2 全分页拉取，单次同步上限 10000 键防失控。
- **D7 · 键名安全**：S3 key = `<prefix>/<根目录名>/<工作区相对路径>`（`/` 分隔）。Rust 命令入口统一校验：拒绝含 `..` 路径段、反斜杠、控制字符、前导 `/` 的 key；key 长度 ≤ 1024。前端把远端 key 还原为本地 relPath 后拼绝对路径写盘前，同样校验 `..`（防恶意桶内容目录穿越写盘）。
- **D8 · 多窗口**：同步引擎只在 `main` 窗口装配与运行（含全部自动触发）；其他窗口仅订阅状态渲染。非 main 窗口的手动同步请求经 `emit("sync-request")` 转发给 main 执行（回声广播机制与 settings-changed 一致）。
- **D9 · 不物理删除本地文件**：同步引起的本地删除一律移动到 `<app-data>/sync/trash/`。远端删除不可恢复，故设置界面建议「开启桶版本控制」。

---

## 4. 数据模型

### 4.1 设置扩展（`src/types.ts`）

```ts
export interface S3ProviderPreset {
  id: "qiniu" | "aliyun-oss" | "cloudflare-r2" | "minio" | "aws" | "custom";
  name: string;                 // 七牛云 Kodo / 阿里云 OSS / Cloudflare R2 / MinIO·自建 / AWS S3 / 自定义
  endpointTemplate?: string;    // 含 {region}/{account} 占位，仅预填用
  regionHint?: string;          // 占位提示，如 "cn-east-1（以控制台为准)"
  pathStyleDefault: boolean;    // 寻址风格默认值
}

export const SYNC_PROVIDERS: S3ProviderPreset[] = [ /* 按上述顺序 */ ];

export interface SyncSettings {
  enabled: boolean;             // 总开关，默认 false
  provider: string;             // preset id，默认 "custom"
  endpoint: string;             // 空串 + provider=aws = SDK 默认 AWS 端点
  region: string;               // 默认 "us-east-1"；R2 固定 "auto"
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;        // 可选 STS
  pathStyle: boolean;           // path-style 寻址
  prefix: string;               // 默认 "mditor/"；规范化：非空时以 / 结尾且不以 / 开头
  autoSync: boolean;            // enabled 时默认 true
  autoSyncIntervalMin: number;  // 默认 10；0 = 关闭定时
  syncOnStart: boolean;         // 默认 true
}
```

`Settings` 增加 `sync: SyncSettings`；`DEFAULT_SETTINGS` 给全关默认值；`migrateSettings` 增加幂等归一（缺失补默认、prefix 规范化、非法 interval 归 10）。预设模板（写入 `SYNC_PROVIDERS`，预填后用户可改，均以各厂商控制台实际信息为准）：

| 预设 | endpoint 模板 | region | 寻址 |
|---|---|---|---|
| 七牛云 Kodo | `https://s3.{region}.qiniucs.com` | 如 `cn-east-1` | virtual-host（pathStyle=false） |
| 阿里云 OSS | `https://oss-{region}.aliyuncs.com` | 如 `cn-hangzhou` | virtual-host |
| Cloudflare R2 | `https://{accountId}.r2.cloudflarestorage.com` | 固定 `auto` | path-style 推荐 |
| MinIO/自建 | 完整手填 | 任意（默认 us-east-1） | path-style 默认开 |
| AWS S3 | 可空 | 必填如 `us-east-1` | virtual-host |
| 自定义 | 完整手填 | 手填 | 手选 |

### 4.2 同步清单 manifest

位置：`<app-data>/sync/manifests/<rootHash>.json`，`rootHash` = 工作区根绝对路径 SHA-256 前 16 hex（多根每根一份）。前端读写，遵循现有 app-data 访问方式（`app_data_dir` 命令 + fs 适配层）。

```ts
interface SyncManifest {
  version: 1;
  workspaceRoot: string;        // 绝对路径，用于检测路径漂移（换机/移动后全量重算）
  lastSyncAt: number;           // epoch ms
  files: Record<string, {       // key = 工作区相对路径，posix 风格
    local: { mtimeMs: number; size: number; md5: string | null } | null;  // null = 上次同步时本地无此文件
    remote: { etag: string; size: number; lastModified: string } | null;  // null = 上次同步时远端无此对象
  }>;
}
```

- 本地 md5：同步时计算（WebCrypto `crypto.subtle.digest`），>10MB 跳过记 null（性能）。
- 远端内容比对优先 ETag；**注意**：仅单段 PUT 的 ETag 才是内容 MD5（本应用自己的上传满足）；他源 multipart 上传的对象 ETag 不可比 → 该情况退化为 size+lastModified 判定。在 manifest 注释与本提示词一致。

### 4.3 回收站

`<app-data>/sync/trash/<rootHash>/<时间戳>-<原相对路径>`。v1 不做浏览 UI，仅诊断日志记录移动路径。

---

## 5. 同步算法（核心，严格实现）

### 5.1 固定忽略规则（不提供配置）
- 名称以 `.` 开头的文件/目录（.git 等）
- 符号链接跳过；单文件 >50MB 跳过（记警告）；目录深度 ≤ 32
- 远端 List 结果剥前缀后同样按本规则过滤（远端多出来的隐藏文件不动）

### 5.2 单文件状态判定（相对 manifest 快照）
- `localState ∈ {same, changed, deleted, new}`：无记录且存在 = new；有记录：缺失 = deleted；mtime（**取整到秒比较**，容忍 FS 精度）或 size 变化 = changed，否则 same
- `remoteState ∈ {same, changed, deleted, new}`：无记录且 List 到 = new；有记录：List 不到 = deleted；etag 或 size 或 lastModified 变化 = changed，否则 same

### 5.3 动作矩阵（L × R → 动作）

| 本地\远端 | same | changed | deleted | new |
|---|---|---|---|---|
| **same** | 跳过 | 下载 | 删本地（入回收站） | 下载 |
| **changed** | 上传 | **冲突** | 上传（改动胜过删除） | **冲突** |
| **deleted** | 删远端 | 下载（恢复） | 清除记录 | 不可能* |
| **new** | 不可能* | 不可能* | 不可能* | **首同步冲突** |

\* manifest 有/无记录的先验约束决定不可能格；实现中遇到「不可能」状态一律走冲突处理兜底，不得 panic/静默丢弃。

**冲突处理**（L=changed & R=changed；及首同步两边同名）：
1. 内容相同（md5/etag 匹配）→ 无副本，按新者覆盖另一侧
2. 内容不同 → 新者为胜（本地 mtimeMs vs 远端 lastModified）；败者保存副本 `<原名>.冲突-YYYYMMDD-HHmmss.<原扩展>`（同目录）：
   - 本地胜：上传本地内容；将远端旧内容下载为冲突副本并一并上传
   - 远端胜：远端内容下载为原文件名；本地旧内容改名为冲突副本并上传副本
3. 时钟不可信无法判定新旧 → 以远端为胜者执行第 2 步，结果摘要标记「请人工确认冲突副本」

**可接受的已知行为**（注释说明即可，不修）：本地仅 mtime 变化无内容变化（如 git checkout）会触发一次无害覆盖上传。

### 5.4 编排流程（必须幂等可重入）

```
syncWorkspace(root):
  1. 读 manifest（无 → 首同步模式）
  2. 扫描本地（忽略规则）→ localMap{relPath → stat+md5?}
  3. s3_list(全前缀, 全分页) → remoteMap；剥前缀得 relPath
  4. keys = localMap ∪ remoteMap ∪ manifest.files
  5. 逐 key 判定 L/R → 查矩阵 → 生成操作列表
  6. 执行顺序：冲突副本下载 → 冲突上传 → 普通下载 → 普通上传 → 删除（串行）；
     下载/下载副本并发 ≤3，上传并发 ≤3
     下载前重 stat：若 mtime 比扫描时新（用户正在编辑）→ 跳过该文件并记「脏文件跳过」警告
  7. 每操作成功即更新内存 manifest；单文件失败不中断整体（收集错误）
  8. 落盘 manifest + lastSyncAt；emit sync-state{status:'done', summary}
```

- 崩溃恢复：manifest 仅第 8 步落盘一次；中途崩溃下次按旧清单重算，所有原语幂等（PUT 覆盖 / GET 覆盖 / 删除前 List 确认）→ 整体可安全重入。
- 互斥：同一 root 同步进行中不重复启动（main 窗口引擎内存锁 + status=syncing）。

### 5.5 触发时机（全部仅 main 窗口）
- 手动：菜单「立即同步」、状态栏指示器点击（非 main 窗口 → emit `sync-request` 转发）
- 保存后：保存成功链路（`useAutosave`/`useFile` 的 doSave 成功处）挂 `trigger.onSaved()`，防抖 5s
- 定时：`autoSyncIntervalMin`（默认 10；0 = 关）
- 启动：main 窗口 mount 后延迟 15s（避开启动性能竞争）

### 5.6 状态与事件

```ts
type SyncStatus = "idle" | "syncing" | "error" | "offline";
interface SyncStateEvent {
  status: SyncStatus;
  phase?: "scan" | "list" | "transfer" | "finalize";
  root: string; done: number; total: number; currentFile?: string;
  lastSyncAt?: number;
  error?: { code: string; message: string };
}
```

- 引擎经适配层 `app.emit("sync-state", evt)` 广播；所有窗口 `useSync()` 订阅渲染。
- offline：连续 ≥2 次网络类错误（连接失败/超时）转入，恢复后自动补跑一次。
- 错误码（映射 Rust 返回错误）：`SYNC-001` 凭证/签名错误(401/403)、`SYNC-002` 桶不存在或无权限(404)、`SYNC-003` 网络不可达、`SYNC-004` 超时、`SYNC-005` 文件超限、`SYNC-006` 键名非法、`SYNC-999` 未知。接入 `devAnomaly.ts` 时按其 MD-XXXX 规范新增同步类代码段；同步参数进任何诊断日志前 AK/SK 必须脱敏（前 4 位 + `***`）。

---

## 6. Rust 侧实现

### 6.1 新文件 `src-tauri/src/s3.rs`

```rust
#[derive(Deserialize)]
pub struct S3Config {
    pub endpoint: String,        // 空串 = AWS 默认
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub path_style: bool,
}
```

命令（全部 `async`，`Result<T, String>` 中文可读错误；object_store 用 `AmazonS3Builder`：with_endpoint（空则不设）/ with_region / with_bucket_name / with_access_key_id / with_secret_access_key / with_token（如有）/ `with_virtual_hosted_style_request(!path_style)`；HTTP 仅允许 localhost——校验后再放行）：

| 命令 | 行为 |
|---|---|
| `s3_test_connection(cfg)` | List 1 个键验证连通+凭证+桶；返回 `{bucket, endpoint, region}` |
| `s3_list(cfg, prefix)` | ListObjectsV2 全分页 → `Vec<S3Object{key,size,etag,last_modified}>`；上限 10000 键 |
| `s3_get(cfg, key)` | 返回 `tauri::ipc::Response` 二进制；≤50MB 硬校验（写法参照 `fetch_image` 的 MAX_IMAGE_BYTES） |
| `s3_put(cfg, key, data, mtime_ms)` | 上传并尽力写入 `x-amz-meta-mtime` 自定义元数据（查 object_store PutOptions/attributes API；**若当前版本不支持自定义元数据，则放弃该字段，冲突判定只用 lastModified**，注释说明取舍） |
| `s3_delete(cfg, key)` | 删除对象 |
| `s3_head(cfg, key)` | 404 → `Ok(None)`，其余返回 `S3Object` |

- `validate_key(&str) -> Result<(), String>`（D7 规则）在所有命令入口调用。
- 错误消息不得包含 Authorization 头 / 密钥 / 签名串。
- object_store 自带 HTTP 客户端，不与 `crate::ai::http()` 共享（注释说明）。
- `lib.rs` 的 `invoke_handler` 注册全部新命令。

### 6.2 `Cargo.toml`

```toml
object_store = { version = "<最新稳定>", default-features = false, features = ["aws"] }
```

（走手写 SigV4 备选时不加此依赖，改加 `sha2` + `hmac` 小 crate，并附 AWS 测试向量单测。）

---

## 7. 前端实现

### 7.1 新目录 `src/lib/sync/`（纯逻辑与 IO 分离，便于单测）

| 文件 | 职责 |
|---|---|
| `types.ts` | SyncSettings/S3Object/SyncStateEvent/操作与摘要类型 |
| `s3.ts` | invoke 封装（与 `ai.ts` 现有调用模式一致）；导出 `isSyncSupported()`，各原语函数入口运行时守卫（harmony 抛 `UnsupportedError`，见 §7.5） |
| `ignore.ts` | 忽略规则纯函数 |
| `manifest.ts` | 读写 / rootHash / version 迁移 |
| `engine.ts` | `decideAction(localState, remoteState)` 纯函数（矩阵）；`syncWorkspace(root, io)` 编排——**io 依赖注入**（listLocal/s3List/s3Get/s3Put/s3Delete/readManifest/writeManifest/trashMove），单测用内存桩 |
| `trigger.ts` | 防抖/定时/启动触发，仅 main 窗口装配；harmony 零装配（§7.5） |
| `status.ts` | sync-state 订阅/发布（useSync 消费）；harmony 恒 idle（§7.5） |

### 7.2 设置 UI（`SettingsModal.tsx` 新增「云同步」分区）
- 沿用现有分区/表单结构与样式；保存走 `update(patch)` 函数式更新
- 控件：启用开关（信息不全时开启 → 自动聚焦本分区并提示补全）；预设下拉（切换时预填 endpoint/region/pathStyle，已填值不粗暴覆盖——弹确认或仅空值预填）；endpoint/region/bucket/AK/SK（密码框带显示切换）；prefix；高级折叠（pathStyle / autoSync / 间隔 / 启动同步）
- 「测试连接」：调 `s3_test_connection`，成功显示 ✓ 桶信息，失败按错误码给中文指引（SYNC-001 检查 AK/SK、SYNC-002 检查桶名…）
- SK 框旁固定小字（D4 文案）+「建议为该桶开启版本控制」
- 非 localhost 的 HTTP endpoint 保存阻断
- harmony 运行时：整分区禁用 + 「云同步当前仅支持桌面版」（实现细节见 §7.5）

### 7.3 状态栏与菜单
- `StatusBar.tsx`：右侧同步指示（图标四态 + 悬停显示上次同步时间/摘要；点击 = 手动同步；error 态点击弹错误详情——复用现有 toast/提示机制，先查现有实现再接入）
- `MenuBar.tsx`：文件或工具菜单加「立即同步」（不加快捷键）
- 多窗口：`useSync()` 全窗口渲染状态；非 main 窗口手动点击 → `emit("sync-request")`，main 引擎监听执行

### 7.4 保存链路集成
- doSave 成功后调 `trigger.onSaved()`（防抖 5s）；同步失败不影响保存（toast 非阻塞，不改保存语义）

### 7.5 鸿蒙运行时兼容降级（必须实现，v1 交付范围）

背景：鸿蒙构建是纯 web 包（`npm run build:harmony-web` 产出的 bundle 由 ArkTS 壳加载），**没有 Tauri Rust 侧**——本功能的全部 Rust 命令（§6）在鸿蒙运行时不存在。因此同步功能本体在鸿蒙天然不可用；但降级处理代码必须随 v1 完整交付，保证：鸿蒙构建编译通过、UI 呈禁用态、任何路径下零运行时崩溃、不留死代码。

1. **模块层运行时守卫**（`src/lib/sync/s3.ts`）
   - 导出 `isSyncSupported(): boolean`（内部 `detectRuntime() !== "harmony"`，从 `src/platform/index.ts` 导入）——全部 UI/装配点的**唯一**判定入口，禁止三处各写一份运行时判断。
   - 每个原语封装函数（list/get/put/delete/head/testConnection）入口先判 `isSyncSupported()`；不支持时抛 `UnsupportedError`（从 `src/platform/errors.ts` 导入，复用项目既有约定），消息「云同步当前仅支持桌面版」。这样即使未来某处误调，得到的是明确错误而非 webview 层的静默失败。
   - `import { invoke } from "@tauri-apps/api/core"` 保持静态导入（与 `ai.ts` 现有模式一致；vite 打包鸿蒙 web 包时可正常解析，运行时因守卫在前不会真正触达 invoke）。
2. **引擎与触发器零装配**（`trigger.ts` / `status.ts` 的装配点，即 main 窗口挂载引擎的 useEffect 处）
   - `!isSyncSupported()` 时：不创建定时器、不注册 `sync-state` / `sync-request` 监听、不挂 `onSaved` 钩子、不启动同步——全部直接 return。
   - `useSync()` 在 harmony 下恒返回 `{ status: "idle", supported: false }`（类型上加 `supported: boolean` 字段），消费方据此渲染。
   - 与 D8 的关系：装配点只有一处（main 窗口），在此处叠加运行时判定即可，不影响多窗口转发逻辑。
3. **UI 三处禁用/隐藏**（统一消费 `isSyncSupported()`）
   - `SettingsModal` 云同步分区：整分区控件 `disabled` + 灰显，分区顶部固定提示条「云同步当前仅支持桌面版」（沿用项目现有禁用控件与提示样式，不新造视觉）。
   - `StatusBar` 同步指示器：harmony 下**不渲染**该元素（而不是渲染错误态/转圈）。
   - `MenuBar`「立即同步」菜单项：harmony 下**不渲染**。
4. **防编译回归**
   - 新代码不得引入鸿蒙 web 包下解析失败的模块或全局；`platform/harmony` 适配层**无需**为 sync 新增任何接口（引擎零装配即不会触达 manifest 读写，适配层零改动）。
   - `settings.sync` 字段在鸿蒙照常读写（store 适配层键值一致，v4.11 迁移保证）；`migrateSettings` 的 sync 归一化是纯数据操作，鸿蒙运行无副作用。
   - 完成后必须本地执行 `npm run build:harmony-web` 确认通过（§9 验收 10）。
5. **单测**（vitest）：mock 运行时检测（`vi.mock` `../platform` 的 `detectRuntime` 返回 `"harmony"`，注意 node 环境默认按 tauri 处理，必须显式 mock）：
   - s3.ts 任一原语调用 → rejects，错误为 `UnsupportedError` 且消息含「桌面版」；
   - trigger/status 装配函数 → 定时器/监听注册桩计数为 0，`useSync()` 恒 idle；
   - `isSyncSupported()` 在 tauri/browser 判 true、harmony 判 false。

---

## 8. 安全与隐私（硬性要求）

1. CSP 零变更：不新增 connect-src origin；前端零直接网络请求
2. 不新增 Tauri 权限/capability（fs 访问限于现有范围 + app-data 子目录）
3. 密钥不进日志/诊断/错误消息/事件；诊断脱敏规则见 §5.6
4. 键名双向校验防目录穿越（D7；Rust 入口 + 前端写盘前）
5. 下载内容只落盘到工作区内目标路径或回收站
6. 零遥测；只访问用户配置的单桶单前缀
7. `mditor/README.md` 更新：功能特性 + 安全模型新增「云同步信任边界」小节（对象存储提供方可见内容；建议最小权限子账号/私有桶/版本控制）

---

## 9. 测试（与实现同等优先级）

**Rust**：`cargo check` 通过；`validate_key` 非法用例表单测；手写 SigV4 路线则必须 AWS 官方测试向量 + 中文/空格/`+` 键名用例。

**vitest（同目录 `*.test.ts`）**：
- 矩阵全覆盖：§5.3 每格 + 首同步 + 冲突三分支（内存桩）
- 幂等重入：模拟第 6 步中途失败，重跑结果一致
- ignore 规则、manifest 读写与迁移、prefix 规范化、Settings 迁移归一
- `s3.ts`：vi.mock invoke，断言参数与错误码映射（403→SYNC-001 等）
- 鸿蒙降级（§7.5.5）：mock `detectRuntime` 为 `"harmony"` 后，s3 原语 rejects `UnsupportedError`、装配函数零注册、`isSyncSupported()` 判定三态

**手动验收**（本地 MinIO：`docker run -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address :9001`）：
1. 测试连接 ✓ / 错误凭证给明确中文指引
2. 首同步：中文与空格文件名、嵌套目录、5MB 文件 → 桶内结构与工作区一致
3. 二次同步零操作（仅 List 耗时）
4. A 机改 3 文件同步 → B 机（新 manifest）同步 → 一致
5. 双端先后改同一文件 → 冲突副本双端可见，胜者内容正确
6. 本地删除 → 远端删除；远端删除 → 本地入回收站
7. 断网 → offline 状态，恢复后自动补跑
8. 编辑中的脏文件不被远端覆盖（跳过 + 警告）
9. doc 窗口状态栏与 main 一致；doc 窗口手动同步能触发 main 执行
10. 鸿蒙兼容降级（§7.5）：`npm run build:harmony-web` 编译通过；代码走查确认设置分区禁用态、状态栏/菜单隐藏、引擎零装配均已实现且有单测覆盖（无真机环境时不要求实机验证）

---

## 10. 实施顺序（建议提交粒度）

1. types + DEFAULT_SETTINGS + 迁移 + 单测
2. `s3.rs` + 注册 + `cargo check` + validate_key 单测；同步建立 `s3.ts` 骨架（含 `isSyncSupported()` 与全部原语的 harmony 守卫 + 单测，§7.5.1/7.5.5）
3. 设置 UI 分区 + 测试连接（端到端可用）；同批实现 harmony 分区禁用态（§7.5.3）
4. manifest + ignore + `decideAction` 纯函数全量单测
5. engine 编排 + 手动同步 + 状态栏 + 事件广播（验收 2/3/7 前半）；装配点加 harmony 零装配守卫（§7.5.2），状态栏/菜单按运行时隐藏
6. 冲突/删除/回收站（验收 5/6/8）
7. 自动触发 + 互斥 + offline + sync-request（验收 9 + 7 后半）
8. 诊断/错误码 + README + 三处版本号 minor 递增；终跑 `npm run build:harmony-web` + 全量 `npm test`（验收 10）

> 鸿蒙降级不单独立步：守卫随步 2、禁用 UI 随步 3/5、终验随步 8，避免桌面功能与降级处理脱节导致某批次构建回归。

## 11. 禁止事项

- 引入 `aws-sdk-s3`；前端直连对象存储；新增 CSP origin / Tauri 权限
- 在工作区内写任何同步状态点文件（状态全在 app-data）
- 物理删除本地文件（一律回收站）
- 在鸿蒙端实现同步功能本体（引擎装配/自动触发/真实 S3 调用/为 `platform/harmony` 适配层新增 sync 接口——降级守卫与禁用态除外，见 §7.5）
- 顺手重构无关模块；引入 i18n 框架、状态管理库、keychain
- 在 UI/日志/错误中泄露 SecretKey
