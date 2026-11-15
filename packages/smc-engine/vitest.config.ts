import { nodeProject } from '../../vitest.shared.ts';

// A pure package: the 90% gate (NFR-15). The golden fixtures and property tests run many engines.
// Their files are CPU-bound for 20–30 s each: one after another, so that `pnpm verify` (turbo runs
// every package's tests at once) leaves the other suites' workers room to start within Vitest's 60 s.
export default nodeProject({ coverage: 90, testTimeout: 120_000, fileParallelism: false });
