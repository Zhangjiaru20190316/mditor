//! Mditor — Tauri 2 backend.
//!
//! Responsibilities:
//!   * register plugins (dialog, fs, store, shell)
//!   * build the native menu bar (File / Edit / View / Format / Help)
//!   * expose a couple of small Rust commands that are awkward to do from JS
//!     (appending to the diagnostics log, converting a filesystem path to an
//!      `asset://` URL, resolving the app data dir)
//!   * forward native menu events to the React frontend via `app.emit`

mod commands;
mod ai;

use std::sync::Mutex;

#[cfg(not(target_os = "windows"))]
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

/// Shared state holding a file path passed on the command line at startup
/// (e.g. the user double-clicked a `.md` while the app was NOT running yet).
/// The frontend pulls and clears it once via the `get_pending_file` command.
pub struct PendingFile(pub Mutex<Option<String>>);

/// Extension list — kept in sync with `MD_FILTERS` in `src/lib/tauriFs.ts`.
const MD_EXTS: &[&str] = &["md", "markdown", "mdx", "mdown"];

/// Scan CLI args for the first value that looks like a Markdown file and
/// actually exists on disk. Skips flags (anything starting with `-`) so
/// Tauri/webview args are ignored.
fn find_md_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find_map(|a| {
        if a.starts_with('-') {
            return None;
        }
        let lower = a.to_lowercase();
        let is_md = MD_EXTS
            .iter()
            .any(|e| lower.ends_with(&format!(".{e}")));
        if is_md && std::path::Path::new(a).is_file() {
            Some(a.clone())
        } else {
            None
        }
    })
}

/// All menu item ids. The frontend listens for the `menu` event with these ids
/// (both the macOS native menu clicks and — for structure parity — the frontend
/// menu bar's dispatch ids mirror these).
pub mod menu_ids {
    pub const NEW: &str = "file_new";
    pub const OPEN: &str = "file_open";
    pub const OPEN_FOLDER: &str = "file_open_folder";
    pub const SAVE: &str = "file_save";
    pub const SAVE_AS: &str = "file_save_as";
    pub const EXPORT_PDF: &str = "file_export_pdf";
    pub const EXPORT_HTML: &str = "file_export_html";
    pub const EXPORT_PNG: &str = "file_export_png";
    pub const EXPORT_DOCX: &str = "file_export_docx";
    pub const COPY_RICH: &str = "edit_copy_rich";

    pub const FORMAT_BOLD: &str = "format_bold";
    pub const FORMAT_HIGHLIGHT: &str = "format_highlight";

    pub const VIEW_OUTLINE: &str = "view_outline";
    pub const VIEW_FILETREE: &str = "view_filetree";
    pub const VIEW_FOCUS: &str = "view_focus";
    pub const AI_ASSISTANT: &str = "view_ai_assistant";
    pub const THEME_LIGHT: &str = "theme_light";
    pub const THEME_DARK: &str = "theme_dark";
    pub const THEME_SEPIA: &str = "theme_sepia";
    pub const SETTINGS: &str = "app_settings";
    pub const CHECK_UPDATE: &str = "app_check_update";
}

// Glob import only feeds the (non-Windows) native menu builder above.
#[cfg(not(target_os = "windows"))]
use menu_ids::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance MUST be registered before every other plugin.
    // When the app is already running and a second `.md` is double-clicked,
    // this callback fires with the new command line — we forward the path to
    // the live frontend and raise the window instead of spawning a 2nd process.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = find_md_arg(&args) {
                // Best-effort: if the frontend hasn't mounted its listener yet
                // (shouldn't happen here since the app is already running), it
                // just misses the event.
                let _ = app.emit("open-file", path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PendingFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::append_log,
            commands::app_data_dir,
            commands::get_pending_file,
            ai::ai_chat,
            ai::ai_chat_stream,
        ])
        .setup(|app| {
            // Windows 使用自绘无边框标题栏内的前端菜单栏（MenuBar.tsx），原生
            // 菜单在 decorations:false 下会残留/出现双菜单，故仅在其他平台构建
            // （macOS 的屏幕菜单栏是平台惯例，必须保留）。
            #[cfg(not(target_os = "windows"))]
            {
                let file_menu = SubmenuBuilder::new(app, "文件")
                    .text(NEW, "新建")
                    .text(OPEN, "打开文件…")
                    .text(OPEN_FOLDER, "打开文件夹…")
                    .separator()
                    .text(SAVE, "保存")
                    .text(SAVE_AS, "另存为…")
                    .separator()
                    .text(EXPORT_PDF, "导出 PDF")
                    .text(EXPORT_HTML, "导出 HTML")
                    .text(EXPORT_PNG, "导出图片 (PNG)")
                    .text(EXPORT_DOCX, "导出 Word (docx)")
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "编辑")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .separator()
                    .text(COPY_RICH, "复制为富文本（粘贴到微信/Word 保留格式）")
                    .build()?;

                let view_menu = SubmenuBuilder::new(app, "视图")
                    .text(VIEW_OUTLINE, "切换大纲")
                    .text(VIEW_FILETREE, "切换文件树")
                    .text(VIEW_FOCUS, "专注模式")
                    .text(AI_ASSISTANT, "AI 助手")
                    .separator()
                    .text(THEME_LIGHT, "浅色主题")
                    .text(THEME_DARK, "深色主题")
                    .text(THEME_SEPIA, "护眼主题")
                    .separator()
                    .fullscreen()
                    .build()?;

                let help_menu = SubmenuBuilder::new(app, "帮助")
                    .text(SETTINGS, "设置…")
                    .text(CHECK_UPDATE, "检查更新…")
                    .separator()
                    .about(None)
                    .build()?;

                // 格式 menu: 加粗 / 高光 on the current selection. No accelerators —
                // shortcuts (Ctrl+B / Ctrl+Shift+H) are handled in the editor surface
                // so they never get stolen from other inputs (AI panel, search, …).
                let format_menu = SubmenuBuilder::new(app, "格式")
                    .text(FORMAT_BOLD, "加粗")
                    .text(FORMAT_HIGHLIGHT, "高光")
                    .separator()
                    .item(&PredefinedMenuItem::copy(app, Some("复制为富文本".into()))?)
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&format_menu)
                    .item(&help_menu)
                    .build()?;

                app.set_menu(menu)?;
            }

            // First launch with a file argument (e.g. `mditor.exe note.md` or
            // a double-click before the app was running): stash the path so the
            // frontend can pick it up once it has mounted.
            #[cfg(desktop)]
            {
                let args: Vec<String> = std::env::args().collect();
                if let Some(path) = find_md_arg(&args) {
                    let state = app.state::<PendingFile>();
                    *state.0.lock().unwrap() = Some(path);
                }
            }

            Ok(())
        })
        .on_menu_event(|app_handle, event| {
            // Forward every custom menu click to the frontend as `menu` event.
            // Native (predefined) items (copy/paste/quit/...) are handled by the OS.
            let id = event.id().0.as_str().to_string();
            // Best-effort emit: if the frontend isn't ready yet it just misses it.
            let _ = app_handle.emit("menu", id);
        })
        .run(tauri::generate_context!())
        .expect("error while running Mditor");
}
