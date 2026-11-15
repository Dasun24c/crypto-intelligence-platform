import { configure } from '@testing-library/react';

// Pages behind lazy routes are transformed on their first import. Beside every other suite that can
// take longer than Testing Library's default 1 s wait, so findBy* and waitFor wait up to 5 s.
configure({ asyncUtilTimeout: 5_000 });
