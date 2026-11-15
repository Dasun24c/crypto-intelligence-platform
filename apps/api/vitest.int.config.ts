import swc from 'unplugin-swc';
import { nodeProject } from '../../vitest.shared.ts';

export default nodeProject({
  // Unit and integration tests together: this run is the api's coverage gate.
  include: ['src/**/*.test.ts', 'test/**/*.int.test.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  globalSetup: ['test/global-setup.ts'],
  fileParallelism: false,
  testTimeout: 30_000,
  coverage: 70,
  plugins: [
    swc.vite({
      swcrc: false,
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2024',
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
});
