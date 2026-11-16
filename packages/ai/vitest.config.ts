import { nodeProject } from '../../vitest.shared.ts';

// AI validation is a domain package: the 90% gate (NFR-15). The test fixtures are not counted.
export default nodeProject({ coverage: 90, coverageExclude: ['src/test/**'] });
