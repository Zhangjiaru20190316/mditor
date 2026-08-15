// Image intake: paste/drop a File -> persist next to the document -> return
// markdown `![](...)` with a path the webview can actually render.
//
// Two challenges solved here:
//   1. Where to save. Typora-style: an `assets/` folder beside the .md file.
//      If the buffer is untitled (no path), we fall back to a per-session temp
//      dir under app-data so pasted images aren't lost before first save.
//      TODO(P1): when the file is saved for the first time, migrate temp assets
//      into the document's folder and rewrite the markdown refs.
//   2. How the <img src> resolves. The webview can't load `file://` (CSP).
//      We convert the absolute path to an `asset://` URL via Tauri's
//      `convertFileSrc`, and ALSO emit a relative `assets/...` form for the
//      markdown source (so the .md is portable on disk). Rendering resolves the
//      relative form against the document folder at display time.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { dirOf } from "./tauriFs";
import { joinAbs, toPosix } from "./path-shim";

export interface PersistedImage {
  /** Markdown image syntax to insert into the buffer. */
  markdown: string;
  /** The path/reference written inside the markdown `![](…)`, without the
   *  alt text or brackets. Portable on disk (relative `assets/…` when the doc
   *  has a path, absolute when untitled). Milkdown's ImageBlock onUpload
   *  returns this so the saved markdown stays portable. */
  ref: string;
  /** Absolute filesystem path of the saved file. */
  absPath: string;
}

// Module-level cache of the app-data-dir IPC round trip: pasting image after
// image used to re-invoke `app_data_dir` every time. A failed promise is
// dropped from the cache so the next paste retries.
let appDataDirPromise: Promise<string> | null = null;
function appDataDir(): Promise<string> {
  appDataDirPromise ??= invoke<string>("app_data_dir").catch((e) => {
    appDataDirPromise = null;
    throw e;
  });
  return appDataDirPromise;
}

/**
 * Ensure an assets dir exists with ONE mkdir IPC (recursive mkdir is a no-op
 * success when the dir already exists — mkdir -p semantics), instead of the
 * exists+mkdir pair in tauriFs.ensureDir (two round trips per paste). Errors
 * that indicate the path already exists are swallowed; anything else
 * (permissions, invalid path) still throws to the caller.
 */
async function ensureAssetsDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    if (!/exist/i.test(String(e))) throw e;
  }
}

/** Monotonic in-process sequence, pairing with the timestamp so two pastes in
 *  the same millisecond can never collide. */
let imgSeq = 0;

/**
 * Build a filename that is unique both in-process (timestamp + counter) and
 * across sessions/instances (randomUUID slice). The old `rand(4)` scheme had
 * only 16^4 = 65536 combinations per millisecond — same-ms multi-paste could
 * collide and silently overwrite the earlier file (data loss).
 */
function uniqueImgName(ext: string): string {
  imgSeq += 1;
  const uniq =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : rand(8);
  return `img-${Date.now()}-${imgSeq.toString(36)}-${uniq}${ext}`;
}

/**
 * Persist a pasted/dropped image File and return the markdown to insert.
 *
 * @param file       the image File from the clipboard or drop event
 * @param docPath    absolute path of the current document, or null if untitled
 */
export async function persistImage(
  file: File,
  docPath: string | null
): Promise<PersistedImage> {
  // Decide where it lives on disk.
  let assetsDir: string;
  let relPrefix: string; // what to write in the markdown (relative or absolute)
  if (docPath) {
    const docDir = dirOf(docPath);
    assetsDir = joinAbs(docDir, "assets");
    relPrefix = "assets";
  } else {
    const ad = await appDataDir();
    assetsDir = joinAbs(ad, "scratch-assets");
    relPrefix = toPosix(assetsDir); // absolute for untitled docs
  }
  await ensureAssetsDir(assetsDir);

  const ext = pickExt(file);
  const name = uniqueImgName(ext);
  const absPath = joinAbs(assetsDir, name);

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Write raw bytes via the fs plugin: `Uint8Array` travels as binary. The old
  // path passed `Array.from(bytes)` to a Rust command, boxing every byte into a
  // JS Number and bloating a 10 MB paste to >100 MB peak — a burst-OOM source
  // in its own right. `assetsDir` already exists (ensureAssetsDir).
  await writeFile(absPath, bytes);

  const desc = file.name.replace(/[!"#$%&'()*+,/:;<=>?@[\]^`{|}~]/g, "").slice(0, 60);
  const mdRef = docPath ? `${relPrefix}/${name}` : toPosix(absPath);
  return {
    markdown: `![${desc}](${mdRef})`,
    ref: mdRef,
    absPath,
  };
}

/**
 * Resolve an image src stored in the markdown into a URL the webview can render.
 *
 * The webview cannot load `file://` (CSP) and has no base URL, so a portable
 * relative ref like `assets/pic.png` or an absolute filesystem path must be
 * turned into an `asset://` URL via Tauri's `convertFileSrc`. Relative refs are
 * resolved against the document's directory. http(s)/data/blob/asset URLs and
 * empty strings pass through unchanged. Used by Milkdown's ImageBlock
 * `proxyDomURL` (keeps the markdown portable while the <img> still renders) and
 * by the static markdown renderer for AI/annotation previews.
 */
export function resolveImgSrc(url: string, docPath: string | null): string {
  if (!url) return url;
  if (/^(https?:|data:|asset:|blob:|moz-extension:|chrome-extension:)/i.test(url)) {
    return url;
  }
  try {
    let abs: string;
    // Treat both POSIX-absolute and Windows-absolute (C:\, /…) as absolute.
    if (/^([A-Za-z]:[\\/]|[\\/])/.test(url)) {
      abs = url;
    } else if (docPath) {
      abs = joinAbs(dirOf(docPath), url);
    } else {
      // No doc dir to resolve against — best effort: assume already absolute.
      abs = url;
    }
    return convertFileSrc(abs);
  } catch {
    return url;
  }
}

/** Derive the file extension for a pasted/dropped image File (mime first,
 *  filename fallback, .png last resort). */
function pickExt(file: File): string {
  const t = file.type.toLowerCase();
  if (t === "image/png") return ".png";
  if (t === "image/jpeg" || t === "image/jpg") return ".jpg";
  if (t === "image/gif") return ".gif";
  if (t === "image/webp") return ".webp";
  if (t === "image/svg+xml") return ".svg";
  if (t === "image/bmp") return ".bmp";
  // fall back to the filename extension or png
  const m = file.name.match(/\.(png|jpe?g|gif|webp|svg|bmp)$/i);
  return m ? `.${m[1].toLowerCase()}` : ".png";
}

function rand(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * Re-host a remote image (http/https) locally, Typora-style. The download runs
 * on the Rust side (`fetch_image` command) because the webview CSP blocks
 * outbound fetches (`connect-src 'self' ipc:`); the returned bytes are sniffed
 * for format and persisted through the same persistImage path as pasted files.
 * Returns the markdown to insert, or null if the download failed (caller keeps
 * the original URL text).
 */
export async function persistRemoteImage(
  url: string,
  docPath: string | null
): Promise<string | null> {
  try {
    const buf = await invoke<ArrayBuffer | Uint8Array>("fetch_image", { url });
    // 统一复制为 ArrayBuffer 背书的 Uint8Array（invoke 的二进制返回可能是
    // ArrayBuffer 或 Uint8Array，而 File 构造要求 ArrayBuffer-backed 视图）。
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) return null;
    const { ext, mime } = sniffImage(bytes, url);
    const file = new File([bytes], uniqueImgName(`.${ext}`), { type: mime });
    const r = await persistImage(file, docPath);
    return r.markdown;
  } catch {
    return null;
  }
}

/** 魔数嗅探图片格式（URL 扩展名与 Content-Type 都不可信）；未知格式按 URL
 *  扩展名回退，再退 .png。SVG 是文本格式，按文本头宽松判断。 */
function sniffImage(bytes: Uint8Array, url: string): { ext: string; mime: string } {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return { ext: "png", mime: "image/png" };
  if (startsWith(0xff, 0xd8, 0xff)) return { ext: "jpg", mime: "image/jpeg" };
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return { ext: "gif", mime: "image/gif" };
  if (startsWith(0x42, 0x4d)) return { ext: "bmp", mime: "image/bmp" };
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) && // "RIFF"
    bytes.length > 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  const head = new TextDecoder()
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    return { ext: "svg", mime: "image/svg+xml" };
  }
  const m = url.match(/\.(png|jpe?g|gif|webp|svg|bmp)$/i)?.[1]?.toLowerCase();
  if (m) {
    const ext = m === "jpeg" ? "jpg" : m;
    const mime =
      ext === "jpg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
    return { ext, mime };
  }
  return { ext: "png", mime: "image/png" };
}
