//! Tauri commands invoked from the React frontend.
//!
//! These exist because appending to the diagnostics log efficiently (open in
//! append mode, no read-modify-write) is better from Rust than the JS fs plugin,
//! because the app-data dir path is needed by the store and is easiest from
//! Rust, and because downloading remote images must bypass the webview CSP
//! (`connect-src` deliberately blocks outbound fetches).

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use crate::ai::http;
use tauri::command;
use tauri::{Manager, State};

/// Upper bound for a single remote-image download (guard against pathological
/// URLs pointed at huge files).
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Append a single line to a log file, rotating it when it exceeds `max_bytes`.
///
/// Creates the file and any missing parent directories. When `max_bytes` is
/// provided and the existing file is already larger than that, it is renamed to
/// `<path>.1` (replacing any previous backup) before the new line is written, so
/// the log can never grow unbounded. Designed for the always-on memory
/// diagnostics log written from the webview: an append here is one syscall and
/// is flushed immediately, so the log survives a renderer OOM kill.
#[command]
pub fn append_log(path: String, line: String, max_bytes: Option<u64>) -> Result<(), String> {
    let p = PathBuf::from(&path);
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
                let _ = fs::remove_file(&bak);
                let _ = fs::rename(&p, &bak);
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
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} 字节，上限 {}）",
            bytes.len(),
            MAX_IMAGE_BYTES
        ));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}
