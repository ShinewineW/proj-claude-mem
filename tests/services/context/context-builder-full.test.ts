import { describe, it, expect } from 'bun:test';
import type { ContextInput } from '../../../src/services/context/types.js';

describe('ContextInput full mode', () => {
  it('ContextInput accepts full boolean', () => {
    const input: ContextInput = {
      session_id: 'test',
      full: true,
    };
    expect(input.full).toBe(true);
  });

  it('ContextInput defaults full to undefined', () => {
    const input: ContextInput = {
      session_id: 'test',
    };
    expect(input.full).toBeUndefined();
  });
});
