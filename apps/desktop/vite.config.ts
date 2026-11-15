import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Frontend build for the Tauri WebView. `tauri dev` loads the dev server on port 1420 (devUrl in
 * src-tauri/tauri.conf.json); `tauri build` embeds `dist/` in the binary.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Workspace packages export their TypeScript sources under `@cip/source`, so no prior build is needed.
    conditions: ['@cip/source', 'module', 'browser', 'development|production'],
  },
  // Only CIP_PUBLIC_* variables are exposed to the bundle, so no server setting can ever leak into it.
  envPrefix: 'CIP_PUBLIC_',
  // Keep the Rust compiler output visible when `tauri dev` runs Vite.
  clearScreen: false,
  server: {
    port: 1420,
    // devUrl names this exact port, so fail rather than silently pick another.
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // WebView2 is evergreen Chromium; WKWebView is the system WebKit. Safari 16.4 (macOS 13.3, the
    // bundle's minimum) is also the floor Tailwind CSS 4 needs.
    target: ['es2022', 'chrome111', 'safari16.4'],
    outDir: 'dist',
    emptyOutDir: true,
  },
});
