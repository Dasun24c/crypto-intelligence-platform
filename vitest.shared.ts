import { defineConfig, type ViteUserConfig } from 'vitest/config';

/**
 * Workspace packages export their TypeScript sources under the `@cip/source` condition, so tests
 * and the dev server use sources directly and never need a prior build.
 * Vitest's Node environment resolves through `ssr.resolve`, the browser one through `resolve`.
 */
export const SOURCE_CONDITION = '@cip/source';
const NODE_CONDITIONS = [SOURCE_CONDITION, 'module', 'node', 'development|production'];

export interface NodeProjectOptions {
  include?: string[];
  exclude?: string[];
  /**
   * Line/function/branch coverage gate for this run (NFR-15: 90% for domain packages, 70% for services).
   * Services are gated on their unit + integration run, so their unit-only config sets none.
   */
  coverage?: number;
  setupFiles?: string[];
  globalSetup?: string[];
  testTimeout?: number;
  /** Integration tests share one database: run their files one after another. */
  fileParallelism?: boolean;
  /** Extra files left out of coverage (test helpers). */
  coverageExclude?: string[];
  plugins?: ViteUserConfig['plugins'];
}

export function nodeProject(opts: NodeProjectOptions = {}) {
  return defineConfig({
    plugins: opts.plugins ?? [],
    resolve: { conditions: NODE_CONDITIONS },
    ssr: { resolve: { conditions: NODE_CONDITIONS } },
    // Vitest loads global setup files in its own `__vitest__` environment.
    environments: { __vitest__: { resolve: { conditions: NODE_CONDITIONS } } },
    test: {
      include: opts.include ?? ['src/**/*.test.ts'],
      exclude: opts.exclude ?? ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
      setupFiles: opts.setupFiles ?? [],
      globalSetup: opts.globalSetup ?? [],
      testTimeout: opts.testTimeout ?? 5_000,
      hookTimeout: Math.max(opts.testTimeout ?? 5_000, 120_000),
      fileParallelism: opts.fileParallelism ?? true,
      // Workspace packages are always transformed by Vite (never handed to Node as externals), so the
      // source condition applies everywhere, including global setup files.
      server: { deps: { inline: [/^@cip\//] } },
      coverage: {
        provider: 'v8',
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/*.int.test.ts',
          'src/**/index.ts',
          'src/main.ts',
          'src/cli.ts',
          ...(opts.coverageExclude ?? []),
        ],
        thresholds: opts.coverage
          ? { lines: opts.coverage, functions: opts.coverage, branches: opts.coverage }
          : {},
      },
    },
  });
}
