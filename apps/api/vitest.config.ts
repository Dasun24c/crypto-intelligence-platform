import swc from 'unplugin-swc';
import { nodeProject } from '../../vitest.shared.ts';

// NestJS resolves dependencies from decorator metadata, which SWC emits (as the build does).
// Coverage is gated on the unit + integration run (vitest.int.config.ts).
export default nodeProject({ plugins: [swc.vite({ swcrc: false, ...swcOptions() })] });

function swcOptions() {
  return {
    jsc: {
      parser: { syntax: 'typescript' as const, decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      target: 'es2024' as const,
      keepClassNames: true,
    },
    module: { type: 'es6' as const },
  };
}
