import { nodeProject } from '../../vitest.shared.ts';

// Domain packages carry the 90% gate (NFR-15).
export default nodeProject({ coverage: 90 });
