// Load settings from the store, apply them to the DOM (theme attribute,
// CSS variables for font/size/spacing), and persist changes.
//
// Custom CSS: if `customCssPath` is set, we read the file and inject its
// contents into a <style id="mditor-custom-css"> element. Removing/changing
// the path re-reads and updates. This mirrors Typora's user-CSS mechanism.
//
// Performance: the returned object is memoised so its identity stays stable
// across renders (only changes when `settings` or `loading` change). This
// matters because App passes `settingsApi` to many children and stores it in
// a ref that gates menu/keyboard effect re-registration.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
  loadSettings,
  saveSettings,
} from "../lib/store";
import { DEFAULT_SETTINGS, type Settings, type Theme } from "../types";

const CUSTOM_STYLE_ID = "mditor-custom-css";

/**
 * Lazy theme CSS loaders. Each value is a static dynamic-import expression so
 * Vite extracts one CSS chunk per theme. The default theme ("light") is
 * imported eagerly in main.tsx, so it's intentionally absent here.
 *
 * Themes override rather than replace: a later-loaded stylesheet wins by source
 * order, so we don't bother unlinking the previous one — that keeps the code
 * simple and avoids a flash when toggling back and forth.
 */
const THEME_LOADERS: Partial<Record<Theme, () => Promise<unknown>>> = {
  dark: () => import("../styles/themes/dark.css"),
  sepia: () => import("../styles/themes/sepia.css"),
  claude: () => import("../styles/themes/claude.css"),
  "claude-dark": () => import("../styles/themes/claude-dark.css"),
};

export interface SettingsApi {
  settings: Settings;
  loading: boolean;
  /**
   * Merge a patch into the settings and persist. Accepts a plain Partial or a
   * function of the CURRENT settings (functional update) — the functional form
   * is required for back-to-back updates (e.g. toggles, list appends) so each
   * call sees the previous call's patch instead of a stale snapshot.
   */
  update: (
    patch: Partial<Settings> | ((prev: Settings) => Partial<Settings>)
  ) => Promise<void>;
  setTheme: (t: Theme) => Promise<void>;
  toggleFocus: () => Promise<void>;
  /** Re-read the custom CSS file (call after editing it externally). */
  reloadCustomCss: () => Promise<void>;
}

export function useSettings(): SettingsApi {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Apply settings to the DOM whenever they change.
  useEffect(() => {
    applyToDom(settings);
  }, [settings]);

  // Lazy-load the active theme's CSS on first use (default "light" is already
  // bundled eagerly in main.tsx, so we skip it here).
  const loadedThemesRef = useRef<Set<Theme>>(new Set());
  useEffect(() => {
    const loader = THEME_LOADERS[settings.theme];
    if (!loader) return; // light, or unknown
    if (loadedThemesRef.current.has(settings.theme)) return;
    loadedThemesRef.current.add(settings.theme);
    void loader().catch(() => {
      // load failed (e.g. corrupt file) — allow a retry by dropping the flag
      loadedThemesRef.current.delete(settings.theme);
    });
  }, [settings.theme]);

  // Apply custom CSS file whenever its path changes.
  useEffect(() => {
    void applyCustomCss(settings.customCssPath);
  }, [settings.customCssPath]);

  // Initial load.
  useEffect(() => {
    (async () => {
      try {
        const s = await loadSettings();
        setSettings(s);
      } catch (e) {
        // mditor.json 损坏/不可读：保持默认设置可用（否则是未处理 rejection
        // + 界面无反馈）。不在这轮写入回存，避免用默认值覆盖原配置。
        console.warn("[mditor] 设置加载失败，使用默认设置：", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const update = useCallback(
    async (
      patch: Partial<Settings> | ((prev: Settings) => Partial<Settings>)
    ) => {
      // Merge via a functional setSettings so concurrent setStates (e.g. the
      // initial load) can't be clobbered, and write the merged value back into
      // settingsRef EAGERLY so two back-to-back update() calls chain instead of
      // both reading the same stale snapshot and dropping the first patch
      // (lost-update). `settingsRef.current = settings` on each render then
      // converges to the same object.
      const apply = (prev: Settings): Settings => {
        const p = typeof patch === "function" ? patch(prev) : patch;
        const next = { ...prev, ...p };
        settingsRef.current = next;
        return next;
      };
      const next = apply(settingsRef.current);
      setSettings((prev) => apply(prev));
      await saveSettings(next);
    },
    []
  );

  const setTheme = useCallback(
    async (t: Theme) => update({ theme: t }),
    [update]
  );

  // Functional update: read the current value through the updater, not through
  // a ref snapshot (two rapid toggles must both apply).
  const toggleFocus = useCallback(
    async () => update((s) => ({ focusMode: !s.focusMode })),
    [update]
  );

  const reloadCustomCss = useCallback(async () => {
    await applyCustomCss(settingsRef.current.customCssPath);
  }, []);

  // Stable object: identity only changes when `settings` or `loading` change.
  return useMemo(
    () => ({ settings, loading, update, setTheme, toggleFocus, reloadCustomCss }),
    [settings, loading, update, setTheme, toggleFocus, reloadCustomCss]
  );
}

/** Apply settings as CSS variables + a data-theme attribute on <html>. */
function applyToDom(s: Settings) {
  const root = document.documentElement;
  root.setAttribute("data-theme", s.theme);
  root.style.setProperty("--font-prose", s.fontFamily);
  root.style.setProperty("--font-mono", s.monoFontFamily);
  root.style.setProperty("--font-size", `${s.fontSize}px`);
  root.style.setProperty("--line-height", String(s.lineHeight));
  root.style.setProperty("--para-spacing", `${s.paragraphSpacing}px`);
  // 侧边栏 / AI 面板宽度（拖拽调节后实时驱动布局）
  root.style.setProperty("--sidebar-width", `${s.sidebarWidth}px`);
  root.style.setProperty("--ai-panel-width", `${s.aiPanelWidth}px`);
  document.body.classList.toggle("focus-mode", s.focusMode);
}

async function applyCustomCss(path: string) {
  let el = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_STYLE_ID;
    document.head.appendChild(el);
  }
  if (!path) {
    el.textContent = "";
    return;
  }
  try {
    const css = await readTextFile(path);
    el.textContent = css;
  } catch (e) {
    // file missing/unreadable — clear to avoid stale styles
    el.textContent = `/* failed to load custom css: ${String(e)} */`;
  }
}
