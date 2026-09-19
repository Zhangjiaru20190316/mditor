// S2：AI/S3 密钥的系统凭据存储（Windows Credential Manager，经 DPAPI 加密）。
//
// 背景：Settings 内嵌 aiModels[].apiKey / ragEmbedApiKey / sync.secretAccessKey /
// sessionToken，此前随 tauri-plugin-store 明文写进 app-data 的 mditor.json——
// 云同步用户配置目录、备份软件或本地恶意软件可直接读走 S3 密钥与 LLM key。
//
// 契约（前端 lib/store.ts 消费）：
//   * secret_set(key, value) — 写入（覆盖）；value 为空串 = 删除该槽位
//   * secret_get(key)        — 读取；不存在返回 None
//   * secret_del(key)        — 删除；不存在视为成功（幂等）
//   * key 字符集 [A-Za-z0-9._-]，长度 ≤ 128（目标名前缀另占 7 字符）
//
// 非 Windows 平台返回类型化错误（"此平台暂不支持"）——前端据此走明文兼容
// 路径并留诊断。macOS Keychain / Linux Secret Service / 鸿蒙 HUKS 按同一
// 契约后续接入，前端零改动。
//
// 密钥永不入日志：错误信息只含 GetLastError 码与操作名，不含 key 内容。

use tauri::command;

/// 凭据目标名前缀（Windows 凭据管理器「普通凭据」的地址/名称字段）。
/// 前缀隔离应用命名空间，避免与其他软件的通用凭据冲突。
#[cfg(target_os = "windows")]
const TARGET_PREFIX: &str = "Mditor:";

/// key 白名单校验：任意能进 Credential Manager 目标名的字符都行，但收紧到
/// [A-Za-z0-9._-] 防止意外构造（空 key / 控制字符 / 超长目标名）。
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 {
        return Err("凭据槽位名非法（空或超长）".into());
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err("凭据槽位名含非法字符（允许 [A-Za-z0-9._-]）".into());
    }
    Ok(())
}

// ---- Windows 实现 -----------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::TARGET_PREFIX;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    /// Credential Manager 的目标名长度上限（含我们的前缀）。
    const CRED_MAX_TARGET_NAME: usize = 512;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn err(op: &str) -> String {
        // 只透出系统错误码，绝不带 key 内容或 blob。
        let code = unsafe { GetLastError() };
        format!("系统凭据操作失败（{op}，GetLastError={code}）")
    }

    pub fn target_of(key: &str) -> Result<Vec<u16>, String> {
        let target = format!("{TARGET_PREFIX}{key}");
        if target.len() + 1 > CRED_MAX_TARGET_NAME {
            return Err("凭据槽位名非法（超长）".into());
        }
        Ok(wide(&target))
    }

    pub fn set(key: &str, value: &str) -> Result<(), String> {
        let target = target_of(key)?;
        let user = wide("Mditor");
        let blob = value.as_bytes();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_ptr() as *mut _,
            Comment: std::ptr::null_mut(),
            LastWritten: Default::default(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user.as_ptr() as *mut _,
        };
        // CredWriteW 覆盖同目标名凭据（写入即更新，无需先删）。
        if unsafe { CredWriteW(&cred, 0) } != 0 {
            Ok(())
        } else {
            Err(err("写入"))
        }
    }

    pub fn get(key: &str) -> Result<Option<String>, String> {
        let target = target_of(key)?;
        let mut cred_out: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred_out) } == 0 {
            // 1168 = ERROR_NOT_FOUND：槽位不存在，正常路径（返回 None）。
            return if unsafe { GetLastError() } == 1168 {
                Ok(None)
            } else {
                Err(err("读取"))
            };
        }
        let cred = unsafe { &*cred_out };
        let bytes = unsafe {
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
        };
        let value = String::from_utf8(bytes.to_vec())
            .map_err(|_| "凭据内容非 UTF-8（可能被外部工具改写）".to_string());
        unsafe { CredFree(cred_out as *const core::ffi::c_void) };
        value.map(Some)
    }

    pub fn del(key: &str) -> Result<(), String> {
        let target = target_of(key)?;
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            // 幂等：不存在 = 成功。
            if unsafe { GetLastError() } == 1168 {
                return Ok(());
            }
            return Err(err("删除"));
        }
        Ok(())
    }
}

// ---- 非 Windows 降级 --------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn set(_key: &str, _value: &str) -> Result<(), String> {
        Err("此平台暂不支持系统凭据存储（规划中）".into())
    }
    pub fn get(_key: &str) -> Result<Option<String>, String> {
        Err("此平台暂不支持系统凭据存储（规划中）".into())
    }
    pub fn del(_key: &str) -> Result<(), String> {
        Err("此平台暂不支持系统凭据存储（规划中）".into())
    }
}

// ---- Tauri 命令 -------------------------------------------------------------

#[command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    // 空值 = 清除该槽位（与前端「清空输入框即删除」语义对齐）。
    if value.is_empty() {
        return imp::del(&key);
    }
    imp::set(&key, &value)
}

#[command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    imp::get(&key)
}

#[command]
pub fn secret_del(key: String) -> Result<(), String> {
    validate_key(&key)?;
    imp::del(&key)
}

// ---- 测试 -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_validation() {
        assert!(validate_key("ai.key.default").is_ok());
        assert!(validate_key("sync.secret").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("a b").is_err());
        assert!(validate_key("槽位/中文").is_err());
        assert!(validate_key(&"x".repeat(129)).is_err());
    }

    /// 真实 Credential Manager 往返（仅 Windows dev/CI 机器；目标名带 test
    /// 前缀，结束即清理，不残留用户可见凭据——普通凭据默认不显示在面板，
    /// 且本用例自删）。S2 的核心回归：写入→读回一致→删除幂等。
    #[cfg(target_os = "windows")]
    #[test]
    fn roundtrip_windows_credential_manager() {
        let key = "test.roundtrip.s2";
        assert!(matches!(imp::get(key), Ok(None)));
        imp::set(key, "sk-test-123-密钥").unwrap();
        assert_eq!(imp::get(key).unwrap().as_deref(), Some("sk-test-123-密钥"));
        imp::del(key).unwrap();
        // 幂等删除 + 读回 None。
        imp::del(key).unwrap();
        assert!(matches!(imp::get(key), Ok(None)));
    }

    /// S2 启动开销实测：loadSettings 水合需 4+N 次往返（N=模型数）。测 200
    /// 次 set+get 的耗时分布，报告数据点。默认 ignore（计时非断言）——
    /// `cargo test --offline secrets -- --ignored --nocapture` 运行。
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn bench_windows_credential_roundtrip() {
        let key = "test.bench.s2";
        let mut times = Vec::with_capacity(200);
        for i in 0..200 {
            let t0 = std::time::Instant::now();
            imp::set(key, "sk-bench").unwrap();
            let v = imp::get(key).unwrap();
            times.push(t0.elapsed().as_micros() as f64 / 1000.0);
            assert_eq!(v.as_deref(), Some("sk-bench"));
            if i == 199 {
                imp::del(key).unwrap();
            }
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p50 = times[100];
        let p95 = times[189];
        eprintln!(
            "S2 cred roundtrip (set+get) over 200 iters: p50={p50:.3}ms p95={p95:.3}ms max={:.3}ms",
            times[199]
        );
    }
}
