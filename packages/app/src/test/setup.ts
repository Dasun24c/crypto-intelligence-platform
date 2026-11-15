import { configure } from '@testing-library/react';

// Pages behind lazy routes are transformed on their first import. When verify runs every package's
// suite at once with coverage, beside the local stack, that can take several seconds, so findBy* and
// waitFor wait up to 15 s (they return as soon as the page is there).
configure({ asyncUtilTimeout: 15_000 });
