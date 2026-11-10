import { defineConfig } from 'vitest/config';

const conditions = ['@cip/source', 'module', 'browser', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  // Suites that opt into the Node environment (`@vitest-environment node`) resolve through `ssr`.
  ssr: { resolve: { conditions } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Threads start faster than forked processes on Windows when turbo runs many suites at once.
    pool: 'threads',
    environment: 'jsdom',
    server: { deps: { inline: [/^@cip\//] } },
  },
});
