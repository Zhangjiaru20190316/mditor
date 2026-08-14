//! Tauri commands invoked from the React frontend.
//!
//! These exist because appending to the diagnostics log efficiently (open in
//! append mode, no read-modify-write) is better from Rust than the JS fs plugin,
//! and because the app-data dir path is needed by the store and is easiest from
//! Rust.
//!
//! Note: converting filesystem paths to `asset://` URLs is done in the frontend
//! via `@tauri-apps/api/core` `convertFileSrc`, which is the supported path.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::command;
use tauri::{Manager, State};

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
