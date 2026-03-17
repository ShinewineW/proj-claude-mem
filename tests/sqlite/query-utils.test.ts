import { describe, test, expect } from 'bun:test';
import { assertValidLimit } from '../../src/services/sqlite/query-utils.js';

describe('assertValidLimit', () => {
  test.each([undefined, null, 1, 100, Number.MAX_SAFE_INTEGER])('accepts valid value: %s', (val) => {
    expect(() => assertValidLimit(val)).not.toThrow();
  });

  test.each([
    0, -1, 1.5, NaN, Infinity, -Infinity,
    '10' as any, true as any, {} as any,
  ])('rejects invalid value: %s', (val) => {
    expect(() => assertValidLimit(val)).toThrow('Invalid limit');
  });
});
