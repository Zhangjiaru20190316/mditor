// Auto-update flow on top of @tauri-apps/plugin-updater.
//
// The plugin talks to the Rust-side `tauri-plugin-updater`, which fetches the
// endpoint configured in tauri.conf.json (a `latest.json` manifest hosted on
// GitHub Releases), verifies its signature against the embedded pubkey, and
// returns an `Update` handle. We then download + install the bundle and relaunch.
//
// Two entry points:
//   * checkForUpdate()         — query the endpoint, return a result object.
//   * downloadAndInstall(upd)  — stream the bundle to disk and relaunch on done.
//
// Errors are surfaced as thrown exceptions; callers decide whether to alert or
// silently swallow (e.g. the silent startup check).

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  available: boolean;
  /** New version string, e.g. "0.2.0". Present only when available. */
  version?: string;
  /** Release notes / changelog text from the manifest. */
  body?: string;
  /** The underlying handle used to perform the actual install. */
  update?: Update;
}

export interface DownloadProgress {
  /** Total bytes, if reported by the server. */
  total?: number;
  /** Bytes downloaded so far. */
  downloaded: number;
}

/**
 * Query the configured update endpoint.
 *
 * Throws on network/verification errors — the caller decides whether to alert
 * (manual check) or ignore (silent startup check).
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const upd = await check();
  if (upd === null) {
    return { available: false };
  }
  return {
    available: true,
    version: upd.version,
    body: upd.body,
    update: upd,
  };
}

/**
 * Download and install the given update, streaming progress, then relaunch the
 * app. The install is atomic-ish: on Windows the running .exe is swapped on
 * next launch, hence the `relaunch()` at the end.
 */
export async function downloadAndInstall(
  upd: Update,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  let total: number | undefined;
  let downloaded = 0;

  await upd.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? undefined;
        downloaded = 0;
        onProgress?.({ total, downloaded });
        break;
      case "Progress":
        downloaded += event.data.chunkLength ?? 0;
        onProgress?.({ total, downloaded });
        break;
      case "Finished":
        onProgress?.({ total: total ?? downloaded, downloaded: total ?? downloaded });
        break;
    }
  });

  await upd.close();
  // Relaunch into the freshly installed version.
  await relaunch();
}
