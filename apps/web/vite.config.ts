import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.CIP_DEV_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Only CIP_PUBLIC_* variables are exposed to client code, so a server secret can never be bundled.
  envPrefix: 'CIP_PUBLIC_',
  resolve: { conditions: ['@cip/source', 'module', 'browser', 'development|production'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/healthz': api, '/readyz': api },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          if (id.includes('@tanstack')) return 'tanstack';
          return undefined;
        },
      },
    },
  },
});
