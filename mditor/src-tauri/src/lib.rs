//! Mditor — Tauri 2 backend.
//!
//! Responsibilities:
//!   * register plugins (dialog, fs, store, shell)
//!   * build the native menu bar (File / Edit / View / Format / Help)
//!   * expose a couple of small Rust commands that are awkward to do from JS
//!     (appending to the diagnostics log, converting a filesystem path to an
//!     `asset://` URL, resolving the app data dir)
//!   * forward native menu events to the React frontend via `emit_to` on the
//!     focused window (v4.8 多窗口定向路由)

mod ai;
mod commands;
mod s3;
mod secrets;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[cfg(not(target_os = "windows"))]
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

/// 崩溃取证（v4.12.4）：panic 日志落点。钩子在 run() 装配时还没有
/// AppHandle，setup() 拿到 app-data 后回填；在此之前发生的 panic 兜底写
/// 系统临时目录。
static PANIC_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// v4.12.4 崩溃取证：release 是 panic="abort"，任何 Rust panic 都会无提示
/// 秒退（Windows 事件日志表现为 0xc0000409）。panic hook 在 abort 前仍会
/// 执行——把 panic 追加写进 <app-data>/logs/panic.log，给「打开云同步即无
/// 痕崩溃」这类问题留证据。钩子自身绝不 panic：全部 best-effort，写失败
/// 静默放弃。
fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 保留默认行为（stderr 在 dev 构建可见）。
        default_hook(info);
        let path = PANIC_LOG_PATH
            .get()
            .cloned()
            .unwrap_or_else(|| std::env::temp_dir().join("mditor-panic.log"));
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = format!(
            "[panic] ts={ts} pid={} thread=`{name}` at {loc} — {msg}\n",
            std::process::id()
        );
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            use std::io::Write as _;
            let _ = f.write_all(line.as_bytes());
        }
    }));
}

/// Shared state holding a file path passed on the command line at startup
/// (e.g. the user double-clicked a `.md` while the app was NOT running yet).
/// The frontend pulls and clears it once via the `get_pending_file` command.
pub struct PendingFile(pub Mutex<Option<String>>);

/// 最近聚焦窗口的 label（v4.8 多窗口焦点路由）。单实例的 `open-file` 与
/// 原生菜单事件不再全 app 广播（那会让每个窗口都开同一个文件），改为
/// `emit_to` 只投给焦点窗口。初始值 "main"——启动后没有任何焦点事件时
/// （理论窗口：启动即有文件参数）退化为旧的 main 行为。
pub struct LastFocused(pub Mutex<String>);

/// 焦点路由目标：优先记录的焦点窗口；该窗口已销毁则回落 main。
/// 返回 None = 进程里一个可用窗口都没有（收尾瞬间），调用方自行放弃。
fn focused_webview_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<tauri::WebviewWindow<R>> {
    let label = app.state::<LastFocused>().0.lock().ok().map(|g| g.clone());
    match label {
        Some(l) => app
            .get_webview_window(&l)
            .or_else(|| app.get_webview_window("main")),
        None => app.get_webview_window("main"),
    }
}

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
        let is_md = MD_EXTS.iter().any(|e| lower.ends_with(&format!(".{e}")));
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
    pub const NEW_TEMPLATE: &str = "file_new_template";
    pub const NEW_WINDOW: &str = "file_new_window";
    pub const OPEN: &str = "file_open";
    pub const OPEN_FOLDER: &str = "file_open_folder";
    pub const ADD_FOLDER: &str = "file_add_folder";
    pub const SAVE: &str = "file_save";
    pub const SAVE_AS: &str = "file_save_as";
    pub const EXPORT_PDF: &str = "file_export_pdf";
    pub const EXPORT_HTML: &str = "file_export_html";
    pub const EXPORT_PNG: &str = "file_export_png";
    pub const EXPORT_DOCX: &str = "file_export_docx";
    pub const COPY_RICH: &str = "edit_copy_rich";

    pub const FORMAT_BOLD: &str = "format_bold";
    pub const FORMAT_ITALIC: &str = "format_italic";
    pub const FORMAT_STRIKE: &str = "format_strike";
    pub const FORMAT_CODE: &str = "format_code";
    pub const FORMAT_HIGHLIGHT: &str = "format_highlight";
    pub const INSERT_LINK: &str = "insert_link";
    pub const INSERT_IMAGE: &str = "insert_image";
    pub const INSERT_FOOTNOTE: &str = "insert_footnote";

    pub const VIEW_OUTLINE: &str = "view_outline";
    pub const VIEW_FILETREE: &str = "view_filetree";
    pub const VIEW_SEARCH: &str = "view_search";
    pub const VIEW_FOCUS: &str = "view_focus";
    pub const VIEW_TYPEWRITER: &str = "view_typewriter";
    pub const AI_ASSISTANT: &str = "view_ai_assistant";
    pub const THEME_LIGHT: &str = "theme_light";
    pub const THEME_DARK: &str = "theme_dark";
    pub const THEME_SEPIA: &str = "theme_sepia";
    pub const SETTINGS: &str = "app_settings";
}

// Glob import only feeds the (non-Windows) native menu builder above.
#[cfg(not(target_os = "windows"))]
use menu_ids::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 崩溃取证钩子必须在最早期装配（见 install_panic_logger）。
    install_panic_logger();

    let mut builder = tauri::Builder::default();

    // Single-instance MUST be registered before every other plugin.
    // When the app is already running and a second `.md` is double-clicked,
    // this callback fires with the new command line — we forward the path to
    // the live frontend and raise the window instead of spawning a 2nd process.
    // v4.8 多窗口：open-file 与抬升都定向到焦点窗口（不再全 app 广播——
    // 广播会让每个窗口都开这个文件；硬编码 main 则永远冷落其它窗口）。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = find_md_arg(&args) {
                // Best-effort: if the frontend hasn't mounted its listener yet
                // (shouldn't happen here since the app is already running), it
                // just misses the event.
                if let Some(w) = focused_webview_window(app) {
                    let _ = app.emit_to(w.label(), "open-file", path);
                }
            }
            let target = focused_webview_window(app);
            if let Some(w) = target {
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
        .plugin(tauri_plugin_process::init())
        .manage(PendingFile(Mutex::new(None)))
        .manage(LastFocused(Mutex::new("main".to_string())))
        .manage(commands::TabPayloadStash(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            commands::append_log,
            commands::app_data_dir,
            commands::get_pending_file,
            commands::fetch_image,
            commands::create_doc_window,
            commands::stash_tab_payload,
            commands::take_tab_payload,
            commands::trash_file,
            commands::grant_fs_scope,
            ai::ai_chat,
            ai::ai_chat_stream,
            ai::ai_chat_cancel,
            ai::ai_embed,
            s3::s3_test_connection,
            s3::s3_list,
            s3::s3_get,
            s3::s3_upload_file,
            s3::s3_download_file,
            s3::s3_delete,
            s3::s3_head,
            commands::local_files_equal,
            commands::local_copy_file,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_del,
        ])
        .setup(|app| {
            // 崩溃取证：拿到 app-data 后回填 panic 日志真实落点（此前发生的
            // panic 由钩子兜底写系统临时目录）。
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = PANIC_LOG_PATH.set(dir.join("logs").join("panic.log"));
            }

            // Windows 使用自绘无边框标题栏内的前端菜单栏（MenuBar.tsx），原生
            // 菜单在 decorations:false 下会残留/出现双菜单，故仅在其他平台构建
            // （macOS 的屏幕菜单栏是平台惯例，必须保留）。
            #[cfg(not(target_os = "windows"))]
            {
                let file_menu = SubmenuBuilder::new(app, "文件")
                    .text(NEW, "新建")
                    .text(NEW_TEMPLATE, "从模板新建…")
                    .text(NEW_WINDOW, "新建窗口")
                    .text(OPEN, "打开文件…")
                    .text(OPEN_FOLDER, "打开文件夹…")
                    .text(ADD_FOLDER, "添加文件夹到工作区…")
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
                    .text(VIEW_SEARCH, "在工作区中搜索")
                    .text(VIEW_FOCUS, "专注模式")
                    .text(VIEW_TYPEWRITER, "打字机模式")
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
                    .separator()
                    .about(None)
                    .build()?;

                // 格式 menu: inline formatting + insertions on the current
                // selection. No accelerators — shortcuts (Ctrl+B / Ctrl+Shift+H)
                // are handled in the editor surface so they never get stolen
                // from other inputs (AI panel, search, …).
                let format_menu = SubmenuBuilder::new(app, "格式")
                    .text(FORMAT_BOLD, "加粗")
                    .text(FORMAT_ITALIC, "斜体")
                    .text(FORMAT_STRIKE, "删除线")
                    .text(FORMAT_CODE, "行内代码")
                    .text(FORMAT_HIGHLIGHT, "高光")
                    .separator()
                    .text(INSERT_LINK, "插入链接…")
                    .text(INSERT_IMAGE, "插入图片…")
                    .text(INSERT_FOOTNOTE, "插入脚注")
                    .separator()
                    .item(&PredefinedMenuItem::copy(app, Some("复制为富文本"))?)
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
                    // E4：毒化取值——release 是 panic="abort"，锁中毒时 unwrap
                    // 会直接闪退整个进程（0xc0000409 类别）。
                    let mut st = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    *st = Some(path);
                }
            }

            Ok(())
        })
        .on_menu_event(|app_handle, event| {
            // Forward every custom menu click to the frontend as `menu` event.
            // Native (predefined) items (copy/paste/quit/...) are handled by the OS.
            // v4.8 多窗口：定向投给焦点窗口（全 app 广播会让每个窗口都执行
            // 一次菜单动作——保存/导出全都会串台）。
            let id = event.id().0.as_str().to_string();
            // Best-effort emit: if the frontend isn't ready yet it just misses it.
            if let Some(w) = focused_webview_window(app_handle) {
                let _ = app_handle.emit_to(w.label(), "menu", id);
            }
        })
        // v4.8 多窗口：记录最近聚焦的窗口 label，供单实例 open-file 与原生
        // 菜单事件做 emit_to 定向路由。Focused(false) 不清除记录——失焦瞬
        // 间（比如点进另一个应用）仍应路由到用户最后所在的 Mditor 窗口。
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                let label = window.label().to_string();
                if let Ok(mut g) = window.app_handle().state::<LastFocused>().0.lock() {
                    *g = label;
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Mditor");
}
