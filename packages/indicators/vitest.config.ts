import { nodeProject } from '../../vitest.shared.ts';

// A pure package: the 90% gate (NFR-15). The TA-Lib golden test reads 90,000 candles, hence the timeout.
export default nodeProject({ coverage: 90, testTimeout: 60_000 });
