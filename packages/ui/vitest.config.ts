import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@cip/source', 'module', 'browser', 'development|production'] },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Threads start faster than forked processes on Windows when turbo runs many suites at once.
    pool: 'threads',
  },
});
