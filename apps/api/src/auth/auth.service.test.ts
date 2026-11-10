import { describe, expect, it } from 'vitest';
import { lockoutSeconds } from './auth.service.js';

describe('progressive lockout', () => {
  it('locks at 5, 10, 15 and every further 5 failures, for longer each time', () => {
    const locks = Array.from({ length: 31 }, (_, n) => [n, lockoutSeconds(n)] as const).filter(
      ([, s]) => s !== null,
    );
    expect(locks).toEqual([
      [5, 60],
      [10, 300],
      [15, 900],
      [20, 3600],
      [25, 3600],
      [30, 3600],
    ]);
  });
});
