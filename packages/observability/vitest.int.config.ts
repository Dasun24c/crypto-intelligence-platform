import { nodeProject } from '../../vitest.shared.ts';

// Unit and integration tests together: this run is the package's coverage gate.
export default nodeProject({
  include: ['src/**/*.test.ts', 'test/**/*.int.test.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  globalSetup: ['test/global-setup.ts'],
  fileParallelism: false,
  testTimeout: 30_000,
  coverage: 70,
});
