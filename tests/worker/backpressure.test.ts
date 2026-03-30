import { describe, it, expect } from 'bun:test';

describe('Backpressure', () => {
  describe('getBackpressureLevel', () => {
    const { getBackpressureLevel } = require('../../src/services/worker/backpressure');

    it('should return 0 for low queue depth', () => {
      expect(getBackpressureLevel(5, 20, 50)).toBe(0);
    });

    it('should return 1 for medium queue depth', () => {
      expect(getBackpressureLevel(30, 20, 50)).toBe(1);
    });

    it('should return 2 for high queue depth', () => {
      expect(getBackpressureLevel(60, 20, 50)).toBe(2);
    });

    it('should return 1 at exact L1 threshold', () => {
      expect(getBackpressureLevel(20, 20, 50)).toBe(1);
    });

    it('should return 2 at exact L2 threshold', () => {
      expect(getBackpressureLevel(50, 20, 50)).toBe(2);
    });
  });

  describe('shouldSkipL1', () => {
    const { shouldSkipL1 } = require('../../src/services/worker/backpressure');

    it('should skip Read of log files', () => {
      expect(shouldSkipL1('Read', '{"file_path":"/tmp/output.log"}', {})).toBe(true);
    });

    it('should NOT skip Read of source files', () => {
      expect(shouldSkipL1('Read', '{"file_path":"/src/services/worker/SDKAgent.ts"}', {})).toBe(false);
    });

    it('should skip duplicate tool+target', () => {
      const state: Record<string, unknown> = {};
      shouldSkipL1('Read', '{"file_path":"/src/foo.ts"}', state); // first call — track
      expect(shouldSkipL1('Read', '{"file_path":"/src/foo.ts"}', state)).toBe(true); // duplicate
    });

    it('should NOT skip different target', () => {
      const state: Record<string, unknown> = {};
      shouldSkipL1('Read', '{"file_path":"/src/foo.ts"}', state);
      expect(shouldSkipL1('Read', '{"file_path":"/src/bar.ts"}', state)).toBe(false);
    });
  });

  describe('shouldSkipL2', () => {
    const { shouldSkipL2 } = require('../../src/services/worker/backpressure');

    it('should skip 2 of every 3 with sampleRate=3', () => {
      const state = { backpressureCounter: 0 };
      const results = Array.from({ length: 6 }, () => shouldSkipL2(state, 3));
      // counter 1→skip, 2→skip, 3→keep, 4→skip, 5→skip, 6→keep
      expect(results).toEqual([true, true, false, true, true, false]);
    });
  });
});
