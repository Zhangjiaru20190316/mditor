//! Tauri commands invoked from the React frontend.
//!
//! These exist because appending to the diagnostics log efficiently (open in
//! append mode, no read-modify-write) is better from Rust than the JS fs plugin,
//! because the app-data dir path is needed by the store and is easiest from
//! Rust, and because downloading remote images must bypass the webview CSP
//! (`connect-src` deliberately blocks outbound fetches).

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::ai::http;
use tauri::command;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Upper bound for a single remote-image download (guard against pathological
/// URLs pointed at huge files).
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// True when `p` is a file inside `logs_dir` — directly in it or in any
/// subdirectory. Component-wise check (both sides derive from the same
/// app_data_dir string the `app_data_dir` command returned, so no
/// canonicalization is needed to make them comparable).
///
/// SECURITY（v4.6.2 阶段2审计）：先拒绝任何 `..` 组件——`Path::starts_with`
/// 是词法比较、不解析 `..`，`<logs>/../../evil.bat` 词法上以 logs 开头、
/// 实际却写出日志目录之外。
fn is_log_path_confined(p: &Path, logs_dir: &Path) -> bool {
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    p.parent()
        .is_some_and(|parent| parent.starts_with(logs_dir))
}

/// Append a single line to a log file, rotating it when it exceeds `max_bytes`.
///
/// SECURITY (v3.9.1): `path` arrives from the webview and is therefore
/// untrusted — a compromised renderer could otherwise append to arbitrary
/// files (e.g. `~/.ssh/authorized_keys`, shell profiles) and persist itself.
/// The path is now validated to live inside `<app-data>/logs/`, which is the
/// only directory the diagnostics log legitimately writes to. The command is
/// also `async` so the filesystem work runs on the async runtime instead of
/// blocking the app's main thread (it fires every memory-guard tick).
#[command]
pub async fn append_log(
    app: tauri::AppHandle,
    path: String,
    line: String,
    max_bytes: Option<u64>,
) -> Result<(), String> {
    let logs_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    let p = PathBuf::from(&path);
    if !is_log_path_confined(&p, &logs_dir) {
        return Err("log path must be a file inside <app-data>/logs".into());
    }
    // P5：以下是纯阻塞 I/O，原实现直接跑在 tokio worker 上。包进
    // spawn_blocking；轮转失败从静默改为可见（eprintln），避免「日志静默
    // 停写数天」这类事故再次无声发生（见本文件 tests 记录的历史事故）。
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Ensure parent directory exists (best-effort; app-data/logs may not yet).
        if let Some(parent) = p.parent() {
            if !parent.as_os_str().is_empty() {
                let _ = fs::create_dir_all(parent);
            }
        }
        // Rotate when the file exceeds the size cap (keep exactly one backup).
        if let Some(max) = max_bytes {
            if let Ok(meta) = fs::metadata(&p) {
                if meta.len() > max {
                    let bak = format!("{}.1", path);
                    let _ = fs::remove_file(&bak); // 旧备份让位（Windows rename 不覆盖）
                    if let Err(e) = fs::rename(&p, &bak) {
                        eprintln!("[append_log] 日志轮转失败（日志将继续增长）：{e}");
                    }
                }
            }
        }
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(|e| e.to_string())?;
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("日志任务失败：{e}"))?
}

/// Return the per-user app data directory (for the settings store, recent list).
/// Created if missing.
#[command]
pub fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Hand off (and clear) a file path that was passed on the command line at
/// startup — i.e. the app was launched by double-clicking a `.md` while it
/// wasn't running. The React frontend calls this once after mounting.
#[command]
pub fn get_pending_file(state: State<'_, crate::PendingFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// Download a remote image over HTTP(S) from the Rust side. The webview CSP
/// (`connect-src 'self' ipc:`) deliberately blocks outbound fetches, so the
/// "persist remote image locally" feature re-hosts files through this command
/// instead. Returns the raw response bytes as a binary IPC response (capped at
/// `MAX_IMAGE_BYTES`); the frontend sniffs the format from magic bytes and
/// writes the file via the fs plugin (see imageManager.ts).
#[command]
pub async fn fetch_image(url: String) -> Result<tauri::ipc::Response, String> {
    // Only http(s) — this command must never double as a local file reader.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http/https 图片地址".into());
    }
    // S3 同源防线：响应字节回传渲染层 = 内网读取原语——拒绝环回/内网/链路
    // 本地目标（云元数据服务、本机管理端口、LAN 服务探测）。
    crate::ai::validate_image_url(&url)?;
    // Shared client (reuses the connection pool across calls). Its original
    // 30s total timeout is preserved per request — the shared client itself
    // deliberately carries none.
    let resp = http()
        .get(&url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_IMAGE_BYTES {
            return Err(format!("图片过大（{len} 字节，上限 {MAX_IMAGE_BYTES}）"));
        }
    }
    let bytes = resp.bytes().await.map_err(|e| format!("下载失败：{e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} 字节，上限 {}）",
            bytes.len(),
            MAX_IMAGE_BYTES
        ));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

// ---- 多窗口（v4.8）----------------------------------------------------------
//
// 每个窗口 = 一个独立 webview = 一份完整 App 实例。Rust 侧只提供三件事：
//   1. create_doc_window —— 建窗（label 恒为 doc-{n}，第一窗口 main 由
//      tauri.conf.json 静态定义，冷启动路径只属于 main）
//   2. stash_tab_payload / take_tab_payload —— 标签迁移的中转站（存-取-删）。
//      大内容（未命名脏缓冲、几百 KB 文档快照）绝不走 URL 查询参数，URL 只
//      允许 path / handoff 两个短参数
//   3. （焦点路由在 lib.rs：LastFocused 状态 + emit_to）

/// 文档窗口 label 计数器：doc-1、doc-2、… 单调递增不复用（窗口关闭后旧
/// label 不回收，事件/监听里悬挂的旧 label 不会被新窗口误认领）。
static DOC_WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

/// 标签迁移载荷有效期。正常路径下新窗口 webview 启动后几秒内即取走；
/// 60s 只是「新窗口启动失败」时的防泄漏兜底，过期条目在后续存取时惰性清理。
const TAB_STASH_TTL: Duration = Duration::from_secs(60);

/// 标签迁移中转站：id -> (JSON 载荷, 创建时刻)。进程内内存态，不落盘。
pub struct TabPayloadStash(pub Mutex<HashMap<String, (String, Instant)>>);

/// handoff id 序号（与时间戳拼合，进程内唯一足矣）。
static TAB_STASH_SEQ: AtomicU64 = AtomicU64::new(0);

/// 查询值百分号编码：仅保留未保留字符（RFC 3986 的 ALPHA / DIGIT / `-_.~`），
/// 其余（中文、空格、`#`、`&`、`=`）按字节百分号编码。与前端
/// encodeURIComponent 的字符类对齐（后者还豁免 `!'()*`，decodeURIComponent
/// 对两种产物都能正确解码）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 暂存一份标签迁移载荷，返回 handoff id（60s TTL，取即删）。
#[command]
pub fn stash_tab_payload(state: State<'_, TabPayloadStash>, payload: String) -> String {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    // 惰性清理过期条目：无需定时器，任意一次存取都顺带扫掉泄漏。
    map.retain(|_, (_, at)| at.elapsed() < TAB_STASH_TTL);
    let id = format!(
        "ho-{}-{}",
        TAB_STASH_SEQ.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    map.insert(id.clone(), (payload, Instant::now()));
    id
}

/// 取回（并删除）一份标签迁移载荷。id 不存在 / 已过期 / 已被取走 → None，
/// 前端按「无 handoff」处理（新窗口落到空白未命名标签，不阻塞启动）。
#[command]
pub fn take_tab_payload(state: State<'_, TabPayloadStash>, id: String) -> Option<String> {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, (_, at)| at.elapsed() < TAB_STASH_TTL);
    map.remove(&id).map(|(payload, _)| payload)
}
/// S1：把用户显式选择的路径动态加入 fs 与 asset 协议作用域。
/// 静态 capability 只保留 $APPDATA/$DOCUMENT；一切「用户意图」路径——对话框
/// 选择的工作区/文件/另存目标、启动恢复的工作区、双击打开、拖放——经此
/// 运行时授权。目录按需递归（工作区根），文件单点。
#[command]
pub fn grant_fs_scope(
    app: tauri::AppHandle,
    paths: Vec<String>,
    recursive: bool,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    for p in &paths {
        if p.is_empty() {
            continue;
        }
        let path = std::path::PathBuf::from(p);
        if path.is_dir() && recursive {
            app.fs_scope()
                .allow_directory(&path, true)
                .map_err(|e| format!("授权目录失败：{e}"))?;
        } else {
            app.fs_scope()
                .allow_file(&path)
                .map_err(|e| format!("授权文件失败：{e}"))?;
        }
        // asset 协议同步放行（笔记图片走 asset:// 显示）。失败不致命——
        // 退化为该路径下图片不可见，不影响文本功能。
        let _ = app.asset_protocol_scope().allow_file(&path);
        if path.is_dir() {
            let _ = app.asset_protocol_scope().allow_directory(&path, true);
        }
    }
    Ok(())
}

// ---- 回收站删除（v4.9 Agent 删除红线：trash > rm——删除必须可恢复）----------
//
// 零依赖实现（不引入 trash crate，延续 v4.8 的零新增 Rust 依赖纪律）：
//   * Windows：PowerShell 的 Microsoft.VisualBasic.FileIO（SendToRecycleBin），
//     文件与目录（整目录）都支持。路径经环境变量传入——完全绕开引号/转义
//     问题（含中文、空格、`&` 等文件名）。
//   * macOS：osascript 让 Finder 删除（进废纸篓）。
//   * Linux：gio trash（GLib 桌面环境标配），退化尝试 trash-put。
// 任何一条路径失败都返回带 stderr 的错误，绝不回落到不可恢复删除。

/// 把一个文件（或目录，含内容）移入系统回收站。
/// P4：PowerShell 冷启动实测 329–542ms（perf/trash-probe.mjs）——同步命令
/// 在主线程等待，每次删除整个窗口 UI 冻结同等时长。改为异步命令 +
/// spawn_blocking：等待移入独立阻塞线程池，主线程与 async worker 均不阻塞。
#[command]
pub async fn trash_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    let is_dir = p.is_dir();
    tauri::async_runtime::spawn_blocking(move || trash_on_current_os(&p, is_dir))
        .await
        .map_err(|e| format!("删除任务失败：{e}"))?
}

#[cfg(target_os = "windows")]
fn trash_on_current_os(p: &Path, is_dir: bool) -> Result<(), String> {
    // 路径经 env 传入 PowerShell：CreateProcessW 的 unicode 环境块原样保真，
    // 脚本里只引用 $env: 变量，不存在任何转义面。
    let method = if is_dir {
        "DeleteDirectory"
    } else {
        "DeleteFile"
    };
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.FileIO.FileSystem]::{method}(\
         $env:MDITOR_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env("MDITOR_TRASH_PATH", p)
        .output()
        .map_err(|e| format!("启动 PowerShell 失败：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "移入回收站失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(target_os = "macos")]
fn trash_on_current_os(p: &Path, _is_dir: bool) -> Result<(), String> {
    // Finder 的 delete 即移入废纸篓。路径里的反斜杠与双引号转义后内联。
    let quoted = p
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script = format!("tell application \"Finder\" to delete POSIX file \"{quoted}\"");
    let out = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("启动 osascript 失败：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "移入废纸篓失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(target_os = "linux")]
fn trash_on_current_os(p: &Path, _is_dir: bool) -> Result<(), String> {
    // 参数直接经 exec 传入（无 shell），无转义面。gio 优先，trash-put 兜底。
    for tool in ["gio trash", "trash-put"] {
        let (prog, rest) = tool.split_once(' ').unwrap_or((tool, ""));
        let mut cmd = std::process::Command::new(prog);
        if !rest.is_empty() {
            cmd.arg(rest);
        }
        if let Ok(out) = cmd.arg(p).output() {
            if out.status.success() {
                return Ok(());
            }
        }
    }
    Err("移入回收站失败：系统无 gio / trash-put 可用（freedesktop trash 协议工具）".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn trash_on_current_os(_p: &Path, _is_dir: bool) -> Result<(), String> {
    Err("当前平台不支持回收站删除".into())
}

/// 新建一个文档窗口（label = doc-{n}，第一窗口 main 恒由配置静态创建）。
///
/// * URL 只带短参数：`index.html?path=…&handoff=…`（只拼有值的参数）；
///   未命名脏缓冲等大内容走 stash。`WebviewUrl::App` 在 dev（devUrl 拼接）
///   与 build（frontendDist / 自定义协议）两种模式下都正确解析。
/// * 级联定位：相对源窗口 outerPosition 偏移 (32, 32)。越界取 clamp ≥ 0
///   而非回卷——源窗口贴屏幕左/上沿时偏移出界是常态，回卷到屏幕另一端反而
///   让新窗「瞬移」；clamp 保证新窗始终可见且级联感成立。
/// * 尺寸 / minSize / decorations 照抄 main（tauri.conf.json 的窗口配置），
///   自绘标题栏（TitleBar 用 getCurrentWindow()）天然按窗口生效。
#[command]
pub async fn create_doc_window(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    path: Option<String>,
    handoff: Option<String>,
) -> Result<String, String> {
    // 分配 label：计数器单调递增 + 存活检查双保险（正常不撞；撞了自增重试）。
    let mut label = String::new();
    for _ in 0..100 {
        let candidate = format!("doc-{}", DOC_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
        if app.get_webview_window(&candidate).is_none() {
            label = candidate;
            break;
        }
    }
    if label.is_empty() {
        return Err("无法分配文档窗口 label".into());
    }

    let mut url = String::from("index.html");
    let mut sep = '?';
    if let Some(p) = &path {
        url.push(sep);
        url.push_str("path=");
        url.push_str(&urlencode(p));
        sep = '&';
    }
    if let Some(h) = &handoff {
        url.push(sep);
        url.push_str("handoff=");
        url.push_str(&urlencode(h));
    }

    // 级联定位（逻辑坐标；outerPosition 是物理坐标，按源窗口 scale 换算）。
    let scale = caller.scale_factor().unwrap_or(1.0);
    let pos = caller.outer_position().map_err(|e| e.to_string())?;
    let x = (pos.x as f64 / scale + 32.0).max(0.0);
    let y = (pos.y as f64 / scale + 32.0).max(0.0);

    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Mditor")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .decorations(false)
        .position(x, y)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(win.label().to_string())
}

// ---- 云同步本地文件原语（v4.12.4）-------------------------------------------
//
// 与 s3.rs 的 s3_upload_file / s3_download_file 配套：冲突比对与副本落位
// 也把字节留在 Rust 侧（前端零大内存），不再经 JS 读整文件。

/// 两个本地文件字节等值（云同步冲突内容比对）。大小不同直接短路；其余
/// 分块流式比对（256KB，零大内存），读盘放到阻塞线程池避免卡 async
/// runtime（对齐 append_log 先例）。任一文件不可读 → Err。
#[command]
pub async fn local_files_equal(a: String, b: String) -> Result<bool, String> {
    let ma = fs::metadata(&a).map_err(|e| format!("读取文件信息失败：{e}"))?;
    let mb = fs::metadata(&b).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !ma.is_file() || !mb.is_file() {
        return Err("比较对象不是常规文件".into());
    }
    if ma.len() != mb.len() {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        /// 读满 buf 或到 EOF，返回实际字节数（fs::read 只保证一次 read 的量）。
        fn read_fill(f: &mut fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
            use std::io::Read;
            let mut n = 0;
            while n < buf.len() {
                match f.read(&mut buf[n..])? {
                    0 => break,
                    k => n += k,
                }
            }
            Ok(n)
        }
        let mut fa = fs::File::open(&a).map_err(|e| format!("读取文件失败：{e}"))?;
        let mut fb = fs::File::open(&b).map_err(|e| format!("读取文件失败：{e}"))?;
        let mut ba = vec![0u8; 256 * 1024];
        let mut bb = vec![0u8; 256 * 1024];
        loop {
            let na = read_fill(&mut fa, &mut ba).map_err(|e| format!("读取文件失败：{e}"))?;
            let nb = read_fill(&mut fb, &mut bb).map_err(|e| format!("读取文件失败：{e}"))?;
            if na != nb {
                return Ok(false); // EOF 位置不同 → 尾部不等
            }
            if na == 0 {
                return Ok(true);
            }
            if ba[..na] != bb[..nb] {
                return Ok(false);
            }
        }
    })
    .await
    .map_err(|e| format!("内部错误：{e}"))?
}

/// 复制本地文件（云同步冲突副本从暂存区落位；字节不经 IPC）。目标父目录
/// 自动创建。
#[command]
pub async fn local_copy_file(from: String, to: String) -> Result<(), String> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err("复制路径为空".into());
    }
    if let Some(parent) = Path::new(&to).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    fs::copy(&from, &to).map_err(|e| format!("复制文件失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Regression (v4.1.2 → v4.2.0): the v3.9.1 confinement check rejected
    /// files lying DIRECTLY in logs/ (only subdirectories passed), while the
    /// frontend swallows append errors — memory.log silently stopped being
    /// written for days before anyone noticed.
    #[test]
    fn confines_files_directly_inside_logs_dir() {
        let logs = Path::new("C:/app-data/logs");
        assert!(is_log_path_confined(
            Path::new("C:/app-data/logs/memory.log"),
            logs
        ));
        assert!(is_log_path_confined(
            Path::new("C:/app-data/logs/dev-events.log"),
            logs
        ));
    }

    #[test]
    fn confines_files_in_subdirectories() {
        let logs = Path::new("C:/app-data/logs");
        assert!(is_log_path_confined(
            Path::new("C:/app-data/logs/dev/events.log"),
            logs
        ));
    }

    #[test]
    fn rejects_paths_outside_logs_dir() {
        let logs = Path::new("C:/app-data/logs");
        assert!(!is_log_path_confined(
            Path::new("C:/Users/me/.ssh/authorized_keys"),
            logs
        ));
        assert!(!is_log_path_confined(
            Path::new("C:/app-data/mditor.json"),
            logs
        ));
        // A sibling that merely shares the "logs" prefix must not pass.
        assert!(!is_log_path_confined(
            Path::new("C:/app-data/logs-evil/x.log"),
            logs
        ));
        // The directory itself is not a confinable file target.
        assert!(!is_log_path_confined(Path::new("C:/app-data/logs"), logs));
    }

    /// SECURITY 回归（v4.6.2）：`..` 词法穿越。`Path::starts_with` 不解析
    /// `..`，不带本检查时 `<logs>/../../evil.bat` 能通过并写出日志目录。
    #[test]
    fn rejects_parent_dir_traversal() {
        let logs = Path::new("C:/app-data/logs");
        assert!(!is_log_path_confined(
            Path::new("C:/app-data/logs/../../evil.bat"),
            logs
        ));
        assert!(!is_log_path_confined(
            Path::new("C:/app-data/logs/sub/../../../x"),
            logs
        ));
        assert!(!is_log_path_confined(
            Path::new("C:/app-data/../app-data/logs/x.log"),
            logs
        ));
        // 无 `..` 的正常路径不受影响。
        assert!(is_log_path_confined(
            Path::new("C:/app-data/logs/sub/x.log"),
            logs
        ));
    }

    /// v4.8 多窗口：查询值编码必须让 URL 特殊字符（`#` `&` `=` `?` 空格）
    /// 与非 ASCII（中文路径）全部转义，否则它们会被当作 URL 结构字符截断
    /// 查询串——`C:\a#b & c.md` 这类文件名会丢参。
    #[test]
    fn urlencode_escapes_url_structural_chars_and_non_ascii() {
        assert_eq!(urlencode("a.md"), "a.md");
        assert_eq!(urlencode("C:/docs/note.md"), "C%3A%2Fdocs%2Fnote.md");
        assert_eq!(urlencode("a#b&c=d e"), "a%23b%26c%3Dd%20e");
        assert_eq!(urlencode("笔记 .md"), "%E7%AC%94%E8%AE%B0%20.md");
        assert_eq!(urlencode("a'b(c)"), "a%27b%28c%29");
    }
}
