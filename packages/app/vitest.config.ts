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
    // At most four: with one worker per core while turbo runs every package's suite at once, workers
    // could not start in time ("Timeout waiting for worker to respond").
    maxWorkers: 4,
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    // The page tests drive the whole app, typing as a user would. When verify runs every package's
    // suite at once with coverage, some take longer than Vitest's default 5 s on this machine, and
    // their waits for the page (`asyncUtilTimeout`, src/test/setup.ts) can take up to 15 s each.
    testTimeout: 60_000,
    server: { deps: { inline: [/^@cip\//] } },
  },
});
