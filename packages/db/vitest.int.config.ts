import { nodeProject } from '../../vitest.shared.ts';

export default nodeProject({
  // Unit and integration tests together: this run is the package's coverage gate.
  include: ['src/**/*.test.ts', 'src/**/*.int.test.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  globalSetup: ['test/global-setup.ts'],
  fileParallelism: false,
  testTimeout: 60_000,
  coverage: 70,
  coverageExclude: ['src/testing.ts'],
});
