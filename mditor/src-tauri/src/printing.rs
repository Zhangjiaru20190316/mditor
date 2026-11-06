//! PI2（应用内打印）：GDI 直打引擎。
//!
//! 设计边界（docs/in-app-print-report.md）：
//!  * 打印全程不经任何外部程序——不打开浏览器/PDF 阅读器、不走 print verb、
//!    不依赖文件关联；也不触碰 WebView2 的打印设施（全仓前端零 print 调用，
//!    printIronRule.test.ts 锚定）。
//!  * 数据流：前端 pdf.js 把打印页光栅化为 PNG（临时文件，$APPDATA/print/
//!    job-*/page-NNN.png）→ `print_png_job` 在后台线程逐页解码为 BGRA →
//!    GDI `StretchDIBits` 等比居中到打印机可打印区。
//!  * 打印机交互三命令：`list_printers`（枚举 + 默认标记）、`print_png_job`
//!    （异步启动，进度经 `print-job-progress` 事件回推）、`print_job_cancel`
//!    （页边界生效的取消）。
//!  * release 构建 panic=abort：本模块任何路径都不允许 panic——锁中毒、
//!    解码失败一律走显式错误字符串（前端 toast，铁律「失败显式」）。
//!  * 非 Windows 桌面构建（本项目当前只发 Windows + harmony）：命令存在但
//!    返回空/不支持，能力面由前端 capabilities.print 门控（harmony false）。
//!
//! windows-sys 0.61 符号分布（链接期查证）：打印机枚举/DEVMODE 协商在
//! `Graphics::Printing`（句柄是 `PRINTER_HANDLE` 结构体）；StartDoc/EndDoc/
//! StartPage/EndPage/AbortDoc/DOCINFOW 在 `Storage::Xps`（gdi32 链接）；
//! DEVMODEW/DC/位图族在 `Graphics::Gdi`。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// 进度事件名（前端 `app.listen("print-job-progress", …)`）。
pub const PRINT_JOB_EVENT: &str = "print-job-progress";

/// 打印作业注册表：job_id → 取消旗标（print_job_cancel 置位，页边界生效）。
#[derive(Default)]
pub struct PrintJobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// 打印机条目（list_printers 返回）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// 打印作业事件载荷。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PrintJobEvent<'a> {
    job: &'a str,
    /// started | page | done | failed | cancelled
    kind: &'a str,
    /// 全局页序（1 起，含份数展开）。
    page: u32,
    /// 全局总页数（copies × pages）。
    total: u32,
    /// failed 附带原因；page 附带打印机名；其余为空。
    message: String,
}

// ---------------------------------------------------------------------------
// 命令面（跨平台签名一致；Windows 实装，其余平台桩）
// ---------------------------------------------------------------------------

/// 枚举本机打印机（本地 + 网络连接），带默认打印机标记。
///
/// 异步 + spawn_blocking：EnumPrintersW（含 PRINTER_ENUM_CONNECTIONS）在网络
/// 打印机/spooler 响应慢时可阻塞秒级，同步命令会冻结主线程（整个窗口）。
#[tauri::command]
pub async fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_printers_impl)
        .await
        .map_err(|e| format!("枚举打印机任务失败：{e}"))?
}

/// 启动打印作业：后台线程执行 GDI 直打，立即返回；进度与终态经
/// `print-job-progress` 事件推送。同一 job_id 的终态事件恰好一条
/// （done / failed / cancelled 三选一）。
///
/// * `pages` — PNG 文件绝对路径列表（已按目标顺序排好；页面范围由调用方
///   决定）。份数优先经 DEVMODE dmCopies 下沉给驱动/spooler 复份（页只
///   解码一遍）；驱动不接受时回退 copies 循环展开。
/// * `paper` — "A4" | "Letter" | "A3"；缺省不设置（用打印机默认纸张，
///   pdf 原文件直打场景按页 fit，不强制纸张）。
#[tauri::command]
pub async fn print_png_job(
    app: AppHandle,
    jobs: State<'_, PrintJobs>,
    job_id: String,
    printer: String,
    copies: u32,
    paper: Option<String>,
    pages: Vec<String>,
) -> Result<(), String> {
    if printer.trim().is_empty() {
        return Err("未指定打印机".into());
    }
    if pages.is_empty() {
        return Err("打印作业没有页面".into());
    }
    // 纵深防御：页路径只允许应用打印临时目录（appDataDir/print/）内——命令
    // 面不成为「把盘上任意文件送物理打印机」的外泄通道。比较前先做词法
    // 规范化（消除 `.`/`..` 段）：纯字符串前缀比较不解析 `..`，
    // `print/../../x.png` 会绕过校验（commands.rs is_log_path_confined 同款
    // 威胁模型）。分隔符归一 + 小写比较（Windows 路径大小写不敏感）。
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败：{e}"))?
        .to_string_lossy()
        .replace('\\', "/");
    let mut base = format!("{}/print/", base_dir.to_lowercase());
    while base.contains("//") {
        base = base.replace("//", "/");
    }
    for p in &pages {
        let Some(norm) = normalize_lexically(p) else {
            return Err("打印页路径越界（仅允许应用打印临时目录）".into());
        };
        if !norm.starts_with(&base) {
            return Err("打印页路径越界（仅允许应用打印临时目录）".into());
        }
    }
    if copies == 0 || copies > 99 {
        return Err(format!("打印份数非法（{copies}），允许 1–99"));
    }
    let paper = match paper.as_deref() {
        None | Some("A4") | Some("Letter") | Some("A3") => paper,
        Some(other) => {
            return Err(format!("纸张规格不支持（{other}），允许 A4 / Letter / A3"))
        }
    };
    let flag = Arc::new(AtomicBool::new(false));
    // 毒化取值（lib.rs E4 同款惯例）：insert 被跳过会产生无法取消的幽灵
    // 作业；锁中毒时注册表本体仍可用（HashMap 未破坏，仅标记位被置）。
    {
        let mut m = jobs.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.contains_key(&job_id) {
            return Err(format!("打印作业已存在（{job_id}）"));
        }
        m.insert(job_id.clone(), flag.clone());
    }
    std::thread::spawn(move || {
        // started 事件移入 run_job：total 依 dmCopies 协商结果而定（驱动
        // 复份 = 页数；回退循环 = 页数 × 份数），协商完成前不可知。
        let result = run_job(&app, &job_id, &printer, copies, paper.as_deref(), &pages, &flag);
        remove_flag(&app, &job_id);
        match result {
            Ok(total) => emit(&app, &job_id, "done", total, total, printer),
            Err(JobError::Cancelled) => emit(&app, &job_id, "cancelled", 0, 0, String::new()),
            Err(JobError::Failed(msg)) => emit(&app, &job_id, "failed", 0, 0, msg),
        }
    });
    Ok(())
}

/// 取消打印作业（页边界生效：当前页输出完成后停止，已出页不撤回）。
#[tauri::command]
pub fn print_job_cancel(jobs: State<'_, PrintJobs>, job_id: String) -> bool {
    // 毒化取值：锁中毒 ≠ 注册表不可用——HashMap 数据仍完整，取消通道必须
    // 保持可用（静默 false 会让前端的取消按钮永久失效）。
    let m = jobs.0.lock().unwrap_or_else(|e| e.into_inner());
    match m.get(&job_id) {
        Some(f) => {
            f.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

fn remove_flag(app: &AppHandle, id: &str) {
    if let Some(jobs) = app.try_state::<PrintJobs>() {
        let mut m = jobs.0.lock().unwrap_or_else(|e| e.into_inner());
        m.remove(id);
    }
}

/// 词法规范化路径为 `/` 分隔的小写形式（消除 `.`/`..` 段；文件无需存在，
/// 与 canonicalize 不同，不因文件未落盘而失败）。`..` 越顶（逃出盘符/
/// UNC 根）返回 None——视为非法路径，调用方拒绝。
fn normalize_lexically(p: &str) -> Option<String> {
    use std::path::{Component, Path};
    let mut out = std::path::PathBuf::new();
    for c in Path::new(p).components() {
        match c {
            Component::Prefix(_) | Component::RootDir => out.push(c.as_os_str()),
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
        }
    }
    Some(out.to_string_lossy().replace('\\', "/").to_lowercase())
}

fn emit(app: &AppHandle, job: &str, kind: &str, page: u32, total: u32, message: String) {
    let _ = app.emit(
        PRINT_JOB_EVENT,
        PrintJobEvent {
            job,
            kind,
            page,
            total,
            message,
        },
    );
}

/// 作业终态错误：Cancelled 走独立事件（不是失败）。
enum JobError {
    Cancelled,
    Failed(String),
}

// ---------------------------------------------------------------------------
// Windows 实装
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateDCW, DeleteDC, DIB_RGB_COLORS, DM_COPIES,
    DM_IN_BUFFER, DM_ORIENTATION, DM_OUT_BUFFER, DM_PAPERSIZE, DMPAPER_A3, DMPAPER_A4,
    DMPAPER_LETTER, DMORIENT_LANDSCAPE, DMORIENT_PORTRAIT, GetDeviceCaps, HALFTONE, HDC, HORZRES,
    PHYSICALOFFSETX, PHYSICALOFFSETY, ResetDCW, SRCCOPY, SetBrushOrgEx, SetStretchBltMode,
    StretchDIBits, VERTRES,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Printing::{ClosePrinter, DocumentPropertiesW, OpenPrinterW};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::Xps::{
    AbortDoc, DOCINFOW, EndDoc, EndPage, StartDocW, StartPage,
};

#[cfg(target_os = "windows")]
fn list_printers_impl() -> Result<Vec<PrinterInfo>, String> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_INFO_4W,
    };

    // 默认打印机（机器无打印机时 GetDefaultPrinterW 失败——不算错误）。
    // 成功时 pcchBuffer 含结尾 NUL（MSDN）：按首个 NUL 截断——直接按长度
    // 切片会把 '\0' 带进 String，与枚举名永不相等（is_default 全体失灵）。
    let mut default_buf = [0u16; 512];
    let mut default_len = default_buf.len() as u32;
    let default_name: Option<String> = unsafe {
        if GetDefaultPrinterW(default_buf.as_mut_ptr(), &mut default_len) != 0 {
            let len = (default_len as usize).min(default_buf.len());
            let end = default_buf[..len]
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(len);
            Some(String::from_utf16_lossy(&default_buf[..end]))
        } else {
            None
        }
    };

    // 枚举（level 4 = 最轻量：名字 + 属性，不逐台打开打印机）。
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed: u32 = 0;
    let mut returned: u32 = 0;
    unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        );
    }
    if needed == 0 {
        return Ok(Vec::new()); // 无打印机（含打印服务不可用）：空清单，前端降级
    }
    // 缓冲区按 8 字节对齐分配（结构含指针成员；+1 单位余量给驱动尾部填充）。
    let quads = (needed as usize).div_ceil(8) + 1;
    let mut buf: Vec<u64> = vec![0; quads];
    let ok = unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            buf.as_mut_ptr() as *mut u8,
            needed,
            &mut needed,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(format!(
            "枚举打印机失败（GetLastError={}）",
            unsafe { GetLastError() }
        ));
    }

    let entries = unsafe {
        std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, returned as usize)
    };
    let list = entries
        .iter()
        .filter_map(|e| unsafe {
            if e.pPrinterName.is_null() {
                None
            } else {
                let mut n = 0usize;
                while *e.pPrinterName.add(n) != 0 {
                    n += 1;
                }
                Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                    e.pPrinterName, n,
                )))
            }
        })
        .map(|name| {
            let is_default = default_name.as_deref() == Some(name.as_str());
            PrinterInfo { name, is_default }
        })
        .collect();
    Ok(list)
}

#[cfg(target_os = "windows")]
fn to_utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 单页解码结果（BGRA、自上而下）。
#[cfg(target_os = "windows")]
struct PageBitmap {
    width: i32,
    height: i32,
    /// 长度 = width*height*4，BGRA 顺序；配负 biHeight（top-down）直用。
    bgra: Vec<u8>,
}

#[cfg(target_os = "windows")]
fn decode_page(path: &str) -> Result<PageBitmap, JobError> {
    let file = std::fs::File::open(path)
        .map_err(|e| JobError::Failed(format!("读取打印页失败（{path}）：{e}")))?;
    let mut decoder = png::Decoder::new(file);
    // 调色板展开 + 16bit 降 8bit，统一到 8bit 输出；通道数读取后分派。
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| JobError::Failed(format!("解码打印页失败（{path}）：{e}")))?;
    // 像素总量上限：巨型分配失败是 abort（catch 不住，release panic=abort
    // 直接整进程闪退）。正常链路 canvas 尺寸远小于此，只有异常/恶意 PNG
    // （IHDR 声称超大尺寸）才会触顶。
    const MAX_PAGE_PIXEL_BYTES: usize = 512 * 1024 * 1024;
    let hdr_w = reader.info().width;
    let hdr_h = reader.info().height;
    if hdr_w == 0 || hdr_h == 0 {
        return Err(JobError::Failed(format!("打印页尺寸异常（{path}）")));
    }
    if hdr_w as usize >= MAX_PAGE_PIXEL_BYTES / 4 / hdr_h as usize {
        return Err(JobError::Failed(format!(
            "打印页过大（{hdr_w}×{hdr_h}）：{path}"
        )));
    }
    let mut raw = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut raw)
        .map_err(|e| JobError::Failed(format!("解码打印页失败（{path}）：{e}")))?;
    let w = info.width as i32;
    let h = info.height as i32;
    if w <= 0 || h <= 0 {
        return Err(JobError::Failed(format!("打印页尺寸异常（{path}）")));
    }
    let mut bgra = Vec::with_capacity((w as usize) * (h as usize) * 4);
    match info.color_type {
        png::ColorType::Rgb => {
            for px in raw.chunks_exact(3) {
                bgra.extend_from_slice(&[px[2], px[1], px[0], 0xff]);
            }
        }
        png::ColorType::Rgba => {
            for px in raw.chunks_exact(4) {
                bgra.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
            }
        }
        png::ColorType::Grayscale => {
            for px in raw.chunks_exact(1) {
                bgra.extend_from_slice(&[px[0], px[0], px[0], 0xff]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for px in raw.chunks_exact(2) {
                bgra.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
        }
        other => return Err(JobError::Failed(format!("打印页色型不支持（{other:?}）"))),
    }
    Ok(PageBitmap { width: w, height: h, bgra })
}

/// GDI 作业主体。返回实际展开后的总页数（started/done 事件用）。份数优先
/// 经 DEVMODE dmCopies 下沉驱动（页循环单遍——同一 PNG 不再 copies 次重复
/// 解码，300 DPI 多份大文档省的是分钟级纯 CPU）；驱动协商不接受（清位或
/// 截低）则回写 dmCopies=1 防 spooler 叠加复制，改走 copies 外循环。
#[cfg(target_os = "windows")]
fn run_job(
    app: &AppHandle,
    job_id: &str,
    printer: &str,
    copies: u32,
    paper: Option<&str>,
    pages: &[String],
    cancel: &AtomicBool,
) -> Result<u32, JobError> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Graphics::Gdi::DEVMODEW;
    use windows_sys::Win32::Graphics::Printing::PRINTER_HANDLE;

    fn gdi_err(step: &str) -> String {
        format!("{step} 失败（GetLastError={}）", unsafe { GetLastError() })
    }

    unsafe {
        // ---- ① 打开打印机 → 取驱动默认 DEVMODE（两步法：先探所需大小）----
        let name_w = to_utf16(printer);
        let mut hprinter = PRINTER_HANDLE::default();
        if OpenPrinterW(name_w.as_ptr(), &mut hprinter, std::ptr::null()) == 0 {
            return Err(JobError::Failed(format!("打开打印机失败（{printer}）")));
        }
        let needed = DocumentPropertiesW(
            std::ptr::null_mut(),
            hprinter,
            name_w.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0, // 仅查询所需字节数
        );
        if needed <= 0 {
            ClosePrinter(hprinter);
            return Err(JobError::Failed(gdi_err("查询打印机设置")));
        }
        // 驱动私有区超过 sizeof(DEVMODEW)：按 8 字节对齐分配（结构含指针
        // 成员；+1 单位余量给驱动尾部填充）。
        let quads = (needed as usize).div_ceil(8) + 1;
        let mut dm_buf: Vec<u64> = vec![0; quads];
        let dm = dm_buf.as_mut_ptr() as *mut DEVMODEW;
        if DocumentPropertiesW(
            std::ptr::null_mut(),
            hprinter,
            name_w.as_ptr(),
            dm,
            std::ptr::null(),
            DM_OUT_BUFFER,
        ) < 0
        {
            ClosePrinter(hprinter);
            return Err(JobError::Failed(gdi_err("读取打印机默认设置")));
        }
        // ---- ② 纸张 + 份数设置 + 驱动验证合并 ----
        if let Some(p) = paper {
            (*dm).dmFields |= DM_PAPERSIZE;
            (*dm).Anonymous1.Anonymous1.dmPaperSize = match p {
                "A4" => DMPAPER_A4 as i16,
                "Letter" => DMPAPER_LETTER as i16,
                "A3" => DMPAPER_A3 as i16,
                _ => 0,
            };
        }
        (*dm).dmFields |= DM_COPIES;
        (*dm).Anonymous1.Anonymous1.dmCopies = copies as i16;
        if DocumentPropertiesW(
            std::ptr::null_mut(),
            hprinter,
            name_w.as_ptr(),
            dm,
            dm,
            DM_IN_BUFFER | DM_OUT_BUFFER,
        ) < 0
        {
            ClosePrinter(hprinter);
            return Err(JobError::Failed(
                "打印机不接受该纸张设置（驱动验证失败）".into(),
            ));
        }
        ClosePrinter(hprinter); // DEVMODE 已到手，句柄使命完成

        // 份数协商判定：驱动保留了 DM_COPIES 位且未被截低才算下沉成功。
        let driver_copies = ((*dm).dmFields & DM_COPIES) != 0
            && (*dm).Anonymous1.Anonymous1.dmCopies >= copies as i16;
        let outer_loops: u32 = if driver_copies {
            1
        } else {
            // 回退外循环前必须压回 dmCopies=1：否则 spooler 按残余 dmCopies
            // 再复制一遍，输出变成 copies × dmCopies。
            if copies > 1 {
                (*dm).dmFields |= DM_COPIES;
                (*dm).Anonymous1.Anonymous1.dmCopies = 1;
            }
            copies
        };
        let total = (pages.len() as u32).saturating_mul(outer_loops);

        // ---- ③ 创建打印 DC + StartDoc ----
        let hdc = CreateDCW(std::ptr::null(), name_w.as_ptr(), std::ptr::null(), dm);
        if hdc.is_null() {
            return Err(JobError::Failed(gdi_err("创建打印设备上下文")));
        }
        let doc_name = to_utf16("Mditor 打印");
        let di = DOCINFOW {
            cbSize: std::mem::size_of::<DOCINFOW>() as i32,
            lpszDocName: doc_name.as_ptr(),
            lpszOutput: std::ptr::null(),
            lpszDatatype: std::ptr::null(),
            fwType: 0,
        };
        if StartDocW(hdc, &di) <= 0 {
            DeleteDC(hdc);
            return Err(JobError::Failed(gdi_err("启动打印作业")));
        }
        emit(app, job_id, "started", 0, total, printer.to_string());

        // ---- ④ 份数 × 页循环（取消在页边界生效）----
        let mut global_index: u32 = 0;
        for _copy in 0..outer_loops {
            for path in pages {
                if cancel.load(Ordering::Relaxed) {
                    AbortDoc(hdc);
                    DeleteDC(hdc);
                    return Err(JobError::Cancelled);
                }
                let page = match decode_page(path) {
                    Ok(p) => p,
                    Err(e) => {
                        AbortDoc(hdc);
                        DeleteDC(hdc);
                        return Err(e);
                    }
                };
                // 方向按页面位图宽高比逐页切换（横竖混排 PDF 支持）。
                let want = if page.width > page.height {
                    DMORIENT_LANDSCAPE as i16
                } else {
                    DMORIENT_PORTRAIT as i16
                };
                if (*dm).Anonymous1.Anonymous1.dmOrientation != want {
                    (*dm).dmFields |= DM_ORIENTATION;
                    (*dm).Anonymous1.Anonymous1.dmOrientation = want;
                    // 个别驱动不支持运行中切向：ResetDC 失败不致命（本页按现
                    // 方向等比居中），回写 dm 保持与 DC 实态一致。
                    if ResetDCW(hdc, dm).is_null() {
                        (*dm).Anonymous1.Anonymous1.dmOrientation = if want
                            == DMORIENT_PORTRAIT as i16
                        {
                            DMORIENT_LANDSCAPE as i16
                        } else {
                            DMORIENT_PORTRAIT as i16
                        };
                    }
                }
                if StartPage(hdc) <= 0 {
                    AbortDoc(hdc);
                    DeleteDC(hdc);
                    return Err(JobError::Failed(gdi_err("开始打印页")));
                }
                if !stretch_page(hdc, &page) {
                    AbortDoc(hdc);
                    DeleteDC(hdc);
                    return Err(JobError::Failed(
                        "打印机可打印区域异常（HORZRES/VERTRES≤0），作业已中止".into(),
                    ));
                }
                if EndPage(hdc) <= 0 {
                    AbortDoc(hdc);
                    DeleteDC(hdc);
                    return Err(JobError::Failed(gdi_err("输出打印页")));
                }
                global_index += 1;
                emit(app, job_id, "page", global_index, total, printer.to_string());
            }
        }
        // ---- ⑤ 收册 ----
        if EndDoc(hdc) <= 0 {
            DeleteDC(hdc);
            return Err(JobError::Failed(gdi_err("完成打印作业")));
        }
        DeleteDC(hdc);
        Ok(total)
    }
}

/// 等比缩放居中到打印机可打印区域（HALFTONE 保缩放质量）。返回 false =
/// 设备能力异常（调用方显式失败——静默出白页还计 done 违反铁律 5）。
#[cfg(target_os = "windows")]
unsafe fn stretch_page(hdc: HDC, page: &PageBitmap) -> bool {
    let printable_w = GetDeviceCaps(hdc, HORZRES as i32);
    let printable_h = GetDeviceCaps(hdc, VERTRES as i32);
    let off_x = GetDeviceCaps(hdc, PHYSICALOFFSETX as i32);
    let off_y = GetDeviceCaps(hdc, PHYSICALOFFSETY as i32);
    if printable_w <= 0 || printable_h <= 0 {
        return false; // 异常驱动：显式失败（原为静默跳过，白页仍计 done）
    }
    let sx = printable_w as f64 / page.width as f64;
    let sy = printable_h as f64 / page.height as f64;
    let s = sx.min(sy);
    let dw = ((page.width as f64 * s).round() as i32).max(1);
    let dh = ((page.height as f64 * s).round() as i32).max(1);
    let dx = off_x + (printable_w - dw) / 2;
    let dy = off_y + (printable_h - dh) / 2;

    SetStretchBltMode(hdc, HALFTONE);
    SetBrushOrgEx(hdc, 0, 0, std::ptr::null_mut()); // HALFTONE 惯例：重置刷原点

    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = page.width;
    bmi.bmiHeader.biHeight = -page.height; // 负值 = 自上而下（与解码序一致）
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    StretchDIBits(
        hdc,
        dx,
        dy,
        dw,
        dh,
        0,
        0,
        page.width,
        page.height,
        page.bgra.as_ptr() as *const core::ffi::c_void,
        &bmi,
        DIB_RGB_COLORS,
        SRCCOPY,
    );
    // StretchDIBits 返回值（拷贝扫描行数）在个别驱动上不可靠，不作失败
    // 判据；到达此处即视为本页输出完成。
    true
}

// ---------------------------------------------------------------------------
// 非 Windows 桩（命令面保持一致，行为显式不支持）
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
fn list_printers_impl() -> Result<Vec<PrinterInfo>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "windows"))]
fn run_job(
    _app: &AppHandle,
    _job_id: &str,
    _printer: &str,
    _copies: u32,
    _paper: Option<&str>,
    _pages: &[String],
    _cancel: &AtomicBool,
) -> Result<u32, JobError> {
    Err(JobError::Failed("当前平台不支持应用内打印".into()))
}
