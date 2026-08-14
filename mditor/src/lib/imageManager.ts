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
import { writeFile } from "@tauri-apps/plugin-fs";
import { ensureDir, dirOf } from "./tauriFs";
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

async function appDataDir(): Promise<string> {
  return invoke<string>("app_data_dir");
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
  await ensureDir(assetsDir);

  const ext = pickExt(file);
  const name = `img-${Date.now()}-${rand(4)}${ext}`;
  const absPath = joinAbs(assetsDir, name);

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Write raw bytes via the fs plugin: `Uint8Array` travels as binary. The old
  // path passed `Array.from(bytes)` to a Rust command, boxing every byte into a
  // JS Number and bloating a 10 MB paste to >100 MB peak — a burst-OOM source
  // in its own right. `assetsDir` already exists (ensureDir).
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

/** Resolve an `asset://` URL for a given absolute path (for preview rendering). */
export function assetUrlFor(absPath: string): string {
  return convertFileSrc(absPath);
}

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
 * Re-host a remote image (http/https) locally. Used for pasting rich HTML that
 * contains <img src="https://...">. Returns the markdown to insert, or null
 * if the fetch failed (in which case the original URL is kept).
 *
 * TODO(P1): wire this into the editor's paste listener for full Typora parity.
 */
export async function persistRemoteImage(
  url: string,
  docPath: string | null
): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const ext =
      (url.match(/\.(png|jpe?g|gif|webp|svg|bmp)$/i)?.[1] ?? "png").toLowerCase();
    const name = `img-${Date.now()}-${rand(4)}.${ext === "jpg" ? "jpg" : ext}`;
    const file = new File([blob], name, { type: blob.type || "image/png" });
    const r = await persistImage(file, docPath);
    return r.markdown;
  } catch {
    return null;
  }
}
