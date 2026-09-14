//! 云同步（v4.12）：S3 协议兼容对象存储的无状态原语命令。
//!
//! 分层契约（与 fetch_image / ai_* 同模式）：Rust 只做 IO 与签名，扫描/
//! 清单/3-way 合并全部在前端 `src/lib/sync/`。CSP 禁止前端直连对象存储，
//! 一切请求经此模块；配置随每次调用传入（D3），Rust 侧不缓存不持久化。
//!
//! 安全约束：
//!   * `validate_key` 在所有携带 key 的命令入口调用（D7）——拒绝 `..`、反
//!     斜杠、控制字符、前导 `/`、超长 key，防恶意桶内容/被篡改前端的目录
//!     穿越与逃逸；
//!   * 错误消息绝不包含 Authorization 头 / 密钥 / 签名串；
//!   * 仅 HTTPS；唯一例外是 localhost/127.0.0.1 endpoint 放行 HTTP（MinIO
//!     本地调试，D6），object_store 侧再以 with_allow_http 放行该连接；
//!   * 单文件 50MB 硬上限（D6）。
//!
//! object_store 自带 reqwest(rustls) 客户端（每命令按配置新建，无进程级
//! 共享状态）——刻意不与 crate::ai::http() 共享：AI 代理客户端刻意无全局
//! 超时（流式），同步客户端需要独立超时语义（30s）。

use futures_util::StreamExt;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as StorePath;
use object_store::{Attribute, Attributes, ClientOptions, ObjectStore, ObjectStoreExt, PutMode, PutOptions};
use serde::Deserialize;
use tauri::command;

/// 单对象字节上限（D6：50MB；与前端 engine 的忽略阈值一致）。
const MAX_OBJECT_BYTES: usize = 50 * 1024 * 1024;

/// 单次 List 返回键上限（防失控；§5.4 编排第 3 步）。
const MAX_LIST_KEYS: usize = 10_000;

/// 所有请求的统一超时（D6：30s；覆盖连接+全程）。
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 前端透传的连接配置（serde camelCase 与前端 S3ConfigPayload 对齐）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    /// 空串 = AWS 默认端点（按 region 自动构造）。
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub path_style: bool,
}

/// s3_list / s3_head 返回的对象元数据（serde camelCase 对齐前端 S3Object）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Object {
    pub key: String,
    pub size: u64,
    pub etag: Option<String>,
    /// RFC3339 字符串（DateTime<Utc> 的 serde 形态）。
    pub last_modified: String,
}

/// 错误消息统一前缀「SYNC-XXX:」（前端 parseSyncError 解析归类）。
fn err(code: &str, msg: impl std::fmt::Display) -> String {
    format!("SYNC-{code}: {msg}")
}

/// key 合法性校验（D7）：拒绝 `..` 路径段、反斜杠、控制字符、前导 `/`，
/// 长度 ≤ 1024。所有携带 key 的命令入口必须调用——前端传来的 key 与远端
/// List 还原出的 key 都不可信（恶意桶内容可构造穿越路径）。
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err(err("006", "对象 key 不能为空"));
    }
    if key.len() > 1024 {
        return Err(err("006", "对象 key 过长（>1024 字节）"));
    }
    if key.starts_with('/') {
        return Err(err("006", "对象 key 不能以 / 开头"));
    }
    if key.contains('\\') {
        return Err(err("006", "对象 key 不能包含反斜杠"));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err(err("006", "对象 key 不能包含控制字符"));
    }
    if key.split('/').any(|seg| seg == "..") {
        return Err(err("006", "对象 key 不能包含 .. 路径段"));
    }
    Ok(())
}

/// endpoint 的明文 HTTP 放行判定：仅 localhost / 127.0.0.1（MinIO 本地调
/// 试，D6）。其余 HTTP 一律拒绝（前端保存时也会阻断，双保险——被篡改的
/// 前端不能把密钥经明文链路发出去）。手写解析（scheme + host 前缀）而非
/// 引入 url crate——这里只需要 host 是否为回环地址这一个事实。
fn http_endpoint_allowed(endpoint: &str) -> bool {
    let lower = endpoint.trim_start().to_ascii_lowercase();
    let rest = match lower.strip_prefix("http://") {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split([':', '/']).next().unwrap_or("");
    host == "localhost" || host == "127.0.0.1"
}

/// 按配置构造 AmazonS3 客户端。HTTPS 无条件放行；HTTP 仅限 localhost。
fn build_store(cfg: &S3Config) -> Result<object_store::aws::AmazonS3, String> {
    let mut builder = AmazonS3Builder::new()
        .with_region(&cfg.region)
        .with_bucket_name(&cfg.bucket)
        .with_access_key_id(&cfg.access_key_id)
        .with_secret_access_key(&cfg.secret_access_key)
        // pathStyle=false → virtual-hosted 寻址；true → path-style（MinIO/R2）。
        .with_virtual_hosted_style_request(!cfg.path_style)
        .with_client_options(ClientOptions::default().with_timeout(REQUEST_TIMEOUT));

    if let Some(token) = cfg.session_token.as_deref() {
        if !token.is_empty() {
            builder = builder.with_token(token);
        }
    }

    let endpoint = cfg.endpoint.trim();
    if !endpoint.is_empty() {
        let lower = endpoint.to_ascii_lowercase();
        if lower.starts_with("http://") && !http_endpoint_allowed(&lower) {
            return Err(err(
                "003",
                "仅允许 HTTPS endpoint（HTTP 仅限 localhost/127.0.0.1 本地调试）",
            ));
        }
        builder = builder.with_endpoint(endpoint);
        if lower.starts_with("http://") {
            // object_store 默认拒绝 HTTP：localhost 调试显式放行。
            builder = builder.with_allow_http(true);
        }
    }

    builder
        .build()
        .map_err(|e| map_store_error("初始化 S3 客户端失败", &e))
}

/// object_store 错误 → 「SYNC-XXX: 中文消息」。绝不透传含签名/密钥的原始
/// 串——Generic 的 source 可能带 Authorization 上下文，只取归类后的固定
/// 文案 + 白名单化的状态/原因片段。
fn map_store_error(ctx: &str, e: &object_store::Error) -> String {
    use object_store::Error::*;
    match e {
        Unauthenticated { .. } => err(
            "001",
            format!("{ctx}：凭证无效或已过期（检查 AccessKey / SecretKey / STS 令牌）"),
        ),
        PermissionDenied { .. } => err(
            "001",
            format!("{ctx}：访问被拒绝（凭证无该操作权限，建议最小权限子账号）"),
        ),
        NotFound { path, .. } => {
            // List/TestConnection 阶段的 NotFound = 桶不存在或无 ListBucket 权限；
            // 对象级 404 由调用方在 map 之前先行短路（s3_head 语义）。
            err("002", format!("{ctx}：桶不存在或无访问权限（{path}）"))
        }
        NotModified { .. } | AlreadyExists { .. } | Precondition { .. } => {
            err("999", format!("{ctx}：{e}"))
        }
        InvalidPath { source } => err("006", format!("{ctx}：对象路径非法（{source}）")),
        // 网络/超时类错误都裹在 Generic 里（reqwest source）：按特征串归类。
        _ => {
            let text = e.to_string();
            if text.contains("timed out") || text.contains("timeout") {
                err("004", format!("{ctx}：请求超时（30s）"))
            } else if text.contains("connect")
                || text.contains("dns")
                || text.contains("connection")
                || text.contains("error sending request")
            {
                err("003", format!("{ctx}：网络不可达或连接被拒"))
            } else {
                // 兜底：只保留前 160 字符的错误轮廓，任何敏感串都在此截断。
                let clipped: String = text.chars().take(160).collect();
                err("999", format!("{ctx}：{clipped}"))
            }
        }
    }
}

/// ObjectMeta → S3Object（serde camelCase）。
fn to_s3_object(m: &object_store::ObjectMeta) -> S3Object {
    S3Object {
        key: m.location.to_string(),
        size: m.size,
        etag: m.e_tag.clone(),
        last_modified: m.last_modified.to_rfc3339(),
    }
}

/// 连通性测试：List 1 个键（验证 endpoint + 凭证 + 桶存在 + ListBucket 权限）。
#[command]
pub async fn s3_test_connection(cfg: S3Config) -> Result<S3ObjectInfo, String> {
    let store = build_store(&cfg)?;
    // 只取第一个条目（空桶 = 流立即结束，同样证明桶可访问、凭证有效）。
    let mut stream = store.list(None);
    if let Some(item) = stream.next().await {
        item.map_err(|e| map_store_error("测试连接失败", &e))?;
    }
    Ok(S3ObjectInfo {
        bucket: cfg.bucket.clone(),
        endpoint: cfg.endpoint.clone(),
        region: cfg.region.clone(),
    })
}

/// 测试连接返回（serde camelCase 对齐前端 S3TestInfo）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ObjectInfo {
    pub bucket: String,
    pub endpoint: String,
    pub region: String,
}

/// ListObjectsV2 全分页拉取（object_store 内部循环分页），上限 MAX_LIST_KEYS。
#[command]
pub async fn s3_list(cfg: S3Config, prefix: String) -> Result<Vec<S3Object>, String> {
    let store = build_store(&cfg)?;
    let filter = if prefix.is_empty() {
        None
    } else {
        Some(StorePath::parse(&prefix).map_err(|e| err("006", format!("前缀非法：{e}")))?)
    };
    let mut out = Vec::new();
    let mut stream = store.list(filter.as_ref());
    while let Some(item) = stream.next().await {
        let m = item.map_err(|e| map_store_error("列举对象失败", &e))?;
        out.push(to_s3_object(&m));
        if out.len() >= MAX_LIST_KEYS {
            break; // 达到防失控上限即停（同步引擎据此提示用户前缀过大）
        }
    }
    Ok(out)
}

/// 下载对象（二进制 IPC 响应；≤50MB 硬校验，写法对齐 fetch_image）。
#[command]
pub async fn s3_get(cfg: S3Config, key: String) -> Result<tauri::ipc::Response, String> {
    validate_key(&key)?;
    let store = build_store(&cfg)?;
    let path = StorePath::from(key.as_str());
    let meta = store
        .head(&path)
        .await
        .map_err(|e| map_store_error("下载失败（对象不存在或无权限）", &e))?;
    if meta.size as usize > MAX_OBJECT_BYTES {
        return Err(err(
            "005",
            format!("对象过大（{} 字节，上限 {}）", meta.size, MAX_OBJECT_BYTES),
        ));
    }
    let result = store
        .get(&path)
        .await
        .map_err(|e| map_store_error("下载失败", &e))?;
    let bytes = result
        .bytes()
        .await
        .map_err(|e| map_store_error("下载失败", &e))?;
    if bytes.len() > MAX_OBJECT_BYTES {
        return Err(err(
            "005",
            format!("对象过大（{} 字节，上限 {}）", bytes.len(), MAX_OBJECT_BYTES),
        ));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// put + 上传后 HEAD 回读（etag/lastModified 供 manifest 记录）。
async fn put_bytes(
    store: &object_store::aws::AmazonS3,
    path: &StorePath,
    bytes: Vec<u8>,
    mtime_ms: Option<f64>,
) -> Result<S3Object, String> {
    let mut options = PutOptions::default();
    if let Some(ms) = mtime_ms {
        if ms.is_finite() && ms >= 0.0 {
            let mut attrs = Attributes::new();
            // Attribute::Metadata 在 AWS 实现里映射为 x-amz-meta-{key} 头。
            attrs.insert(
                Attribute::Metadata("mtime".into()),
                format!("{ms:.0}").into(),
            );
            options.attributes = attrs;
        }
    }
    options.mode = PutMode::Overwrite;

    store
        .put_opts(path, bytes.into(), options)
        .await
        .map_err(|e| map_store_error("上传失败", &e))?;

    let meta = store
        .head(path)
        .await
        .map_err(|e| map_store_error("上传后校验失败", &e))?;
    Ok(to_s3_object(&meta))
}

/// 上传本地文件到对象（v4.12.4 崩溃修复：文件字节不再经 IPC。旧 s3_put 的
/// base64 JSON 通道对 50MB 文件有 ~4.3x 内存放大（Uint8Array + UTF-16 二进
/// 制串 + base64 串叠加），且 WebView2 超大自定义协议请求体是已知崩溃高发
/// 点——事件日志 4 次 0xc0000409 均落在首同步批量上传时段）。Rust 直读文
/// 件后走同一 put 路径；mtimeMs 尽力写入 x-amz-meta-mtime；上传后 HEAD 取
/// 回规范元数据供 manifest。
#[command]
pub async fn s3_upload_file(
    cfg: S3Config,
    key: String,
    local_path: String,
    mtime_ms: Option<f64>,
) -> Result<S3Object, String> {
    validate_key(&key)?;
    if local_path.trim().is_empty() {
        return Err(err("006", "本地文件路径为空"));
    }
    // 先 stat 校验大小再读（避免把超限大文件整个读进内存）。
    let meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| err("006", format!("读取本地文件失败：{e}")))?;
    if meta.len() > MAX_OBJECT_BYTES as u64 {
        return Err(err(
            "005",
            format!("文件过大（{} 字节，上限 {}）", meta.len(), MAX_OBJECT_BYTES),
        ));
    }
    let bytes = tokio::fs::read(&local_path)
        .await
        .map_err(|e| err("006", format!("读取本地文件失败：{e}")))?;
    let store = build_store(&cfg)?;
    let path = StorePath::from(key.as_str());
    put_bytes(&store, &path, bytes, mtime_ms).await
}

/// 下载对象到本地文件（v4.12.4：字节不经 IPC，Rust 直写落盘。先写同目录
/// `.mditor-tmp` 临时文件再改名，避免半写状态；父目录自动创建；Windows 上
/// rename 目标已存在会失败 → 先删旧文件再改名）。返回 HEAD 元数据，调用方
/// 可免二次请求。
#[command]
pub async fn s3_download_file(
    cfg: S3Config,
    key: String,
    dest_path: String,
) -> Result<S3Object, String> {
    validate_key(&key)?;
    if dest_path.trim().is_empty() {
        return Err(err("006", "目标文件路径为空"));
    }
    let store = build_store(&cfg)?;
    let path = StorePath::from(key.as_str());
    let meta = store
        .head(&path)
        .await
        .map_err(|e| map_store_error("下载失败（对象不存在或无权限）", &e))?;
    if meta.size as usize > MAX_OBJECT_BYTES {
        return Err(err(
            "005",
            format!("对象过大（{} 字节，上限 {}）", meta.size, MAX_OBJECT_BYTES),
        ));
    }
    let result = store
        .get(&path)
        .await
        .map_err(|e| map_store_error("下载失败", &e))?;
    let bytes = result
        .bytes()
        .await
        .map_err(|e| map_store_error("下载失败", &e))?;
    if bytes.len() > MAX_OBJECT_BYTES {
        return Err(err(
            "005",
            format!("对象过大（{} 字节，上限 {}）", bytes.len(), MAX_OBJECT_BYTES),
        ));
    }

    let dest = std::path::Path::new(&dest_path);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| err("006", format!("创建目标目录失败：{e}")))?;
        }
    }
    let tmp = format!("{}.mditor-tmp", dest_path);
    let landed = async {
        tokio::fs::write(&tmp, &bytes)
            .await
            .map_err(|e| err("006", format!("写入临时文件失败：{e}")))?;
        if tokio::fs::rename(&tmp, dest).await.is_err() {
            let _ = tokio::fs::remove_file(dest).await;
            tokio::fs::rename(&tmp, dest)
                .await
                .map_err(|e| err("006", format!("落盘失败：{e}")))?;
        }
        Ok::<(), String>(())
    };
    match landed.await {
        Ok(()) => Ok(to_s3_object(&meta)),
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await; // best-effort 清理
            Err(e)
        }
    }
}

/// 删除远端对象（幂等：不存在时 object_store 返回 Ok）。
#[command]
pub async fn s3_delete(cfg: S3Config, key: String) -> Result<(), String> {
    validate_key(&key)?;
    let store = build_store(&cfg)?;
    let path = StorePath::from(key.as_str());
    store
        .delete(&path)
        .await
        .map_err(|e| map_store_error("删除失败", &e))?;
    Ok(())
}

/// HEAD 单对象：404 → Ok(None)，其余错误照常映射。
#[command]
pub async fn s3_head(cfg: S3Config, key: String) -> Result<Option<S3Object>, String> {
    validate_key(&key)?;
    let store = build_store(&cfg)?;
    let path = StorePath::from(key.as_str());
    match store.head(&path).await {
        Ok(m) => Ok(Some(to_s3_object(&m))),
        Err(object_store::Error::NotFound { .. }) => Ok(None),
        Err(e) => Err(map_store_error("查询对象失败", &e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- validate_key（D7 键名安全）----------------------------------------

    #[test]
    fn accepts_normal_keys() {
        assert!(validate_key("mditor/ws/a.md").is_ok());
        // 中文 / 空格 / `+` 等需要 SigV4 正确 canonical 编码的键名均合法。
        assert!(validate_key("mditor/ws/笔记 目录/a+b.md").is_ok());
        assert!(validate_key("a").is_ok());
    }

    #[test]
    fn rejects_traversal_and_escape() {
        // `..` 任意路径段（含中间段）——防目录穿越。
        assert!(validate_key("../evil").is_err());
        assert!(validate_key("mditor/../evil").is_err());
        assert!(validate_key("mditor/ws/../../evil").is_err());
        assert!(validate_key("..").is_err());
        // 反斜杠（Windows 路径分隔符混入）。
        assert!(validate_key("mditor\\ws").is_err());
        // 控制字符（含 \n \t \0）。
        assert!(validate_key("md\nws").is_err());
        assert!(validate_key("md\tws").is_err());
        assert!(validate_key("md\0ws").is_err());
        // 前导 /（绝对 key 逃逸前缀）。
        assert!("/etc/passwd".starts_with('/') && validate_key("/etc/passwd").is_err());
        // 空与超长。
        assert!(validate_key("").is_err());
        let long = "a".repeat(1025);
        assert!(validate_key(&long).is_err());
        // 边界：1024 恰好放行。
        assert!(validate_key(&"a".repeat(1024)).is_ok());
    }

    // ---- http_endpoint_allowed（D6 传输约束）-------------------------------

    #[test]
    fn only_localhost_http_allowed() {
        assert!(http_endpoint_allowed("http://localhost:9000"));
        assert!(http_endpoint_allowed("http://127.0.0.1:9000"));
        assert!(!http_endpoint_allowed("http://192.168.1.5:9000"));
        assert!(!http_endpoint_allowed("http://example.com"));
        assert!(!http_endpoint_allowed("https://example.com")); // https 本就不经此豁免
        assert!(!http_endpoint_allowed("not a url"));
    }
}
