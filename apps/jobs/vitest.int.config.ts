import swc from 'unplugin-swc';
import { nodeProject } from '../../vitest.shared.ts';

export default nodeProject({
  // Unit and integration tests together: this run is the service's coverage gate.
  include: ['src/**/*.test.ts', 'test/**/*.int.test.ts'],
  coverage: 70,
  exclude: ['**/node_modules/**', '**/dist/**'],
  globalSetup: ['test/global-setup.ts'],
  fileParallelism: false,
  testTimeout: 30_000,
  plugins: [
    swc.vite({
      swcrc: false,
      jsc: { parser: { syntax: 'typescript', decorators: true }, target: 'es2024' },
      module: { type: 'es6' },
    }),
  ],
});
