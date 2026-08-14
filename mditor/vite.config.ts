import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 2 expects the frontend to be served on a fixed port in dev and to not
// clear the terminal (it prints its own logs). The ASSETS env var holds the
// frontend dist directory used by Tauri's `frontendDist`.
const FRONTEND_PORT = 1420;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Vite handles the SPA; Tauri reads these via its CLI.
  clearScreen: false,
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Don't trigger dev reloads when the Rust side recompiles.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri webview can resolve these.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    // terser (vs default esbuild) lets us drop console.* in production for a
    // smaller, quieter bundle. esbuild is faster but doesn't do dead-code
    // elimination on console calls.
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
      format: {
        comments: false,
      },
    },
    sourcemap: false,
    // Tauri loads assets from disk, so the per-chunk warning is moot; raise it
    // so the export chunk (html-to-docx alone is 1.6 MB, loaded only on export)
    // doesn't spam warnings.
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        // Split stable third-party libs into their own chunks so that:
        //   * business-code changes don't invalidate the cached vendor chunks
        //   * the webview parses/executes them in parallel on first load
        // NOTE: we deliberately do NOT route the export libs (html-to-docx,
        // juice, modern-screenshot) here. They are dynamic-imported inside
        // exporter.ts, and adding them to manualChunks would make Vite treat
        // the merged chunk as an entry-related chunk and `modulepreload` it —
        // pulling 2 MB into first paint. Leaving them out lets Vite's default
        // dynamic-import code-splitting keep them lazy.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react") || id.includes("scheduler")) {
              return "vendor-react";
            }
            // Keep the Milkdown editor core in its own chunk so business-code
            // changes don't invalidate the cached editor bundle, and the webview
            // can parse it in parallel on first load.
            if (
              id.includes("@milkdown") ||
              id.includes("prosemirror") ||
              id.includes("@codemirror") ||
              id.includes("@lezer")
            ) {
              return "vendor-milkdown";
            }
          }
        },
      },
    },
  },
}));
