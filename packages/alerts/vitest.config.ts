import { nodeProject } from '../../vitest.shared.ts';

// A pure package: the 90% gate (NFR-15).
export default nodeProject({ coverage: 90 });
