import { describe, it, expect, spyOn, beforeEach } from 'bun:test';
import { logger } from '../../../../src/utils/logger.js';

/**
 * Verify that SessionRoutes and MemoryRoutes pass dbPath to getChromaSync().
 *
 * Strategy: Static analysis of source code to verify the pattern.
 * We grep for getChromaSync() calls and ensure they pass dbPath.
 * This is more maintainable than mocking the full Express/DatabaseManager stack.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Chroma dbPath isolation', () => {
  beforeEach(() => {
    spyOn(logger, 'info').mockImplementation(() => {});
    spyOn(logger, 'debug').mockImplementation(() => {});
    spyOn(logger, 'warn').mockImplementation(() => {});
    spyOn(logger, 'error').mockImplementation(() => {});
  });

  describe('B1: SessionRoutes prompt sync', () => {
    it('passes dbPath to getChromaSync in handleSessionInit', () => {
      const source = readFileSync(
        join(__dirname, '../../../../src/services/worker/http/routes/SessionRoutes.ts'),
        'utf-8'
      );

      // Verify getChromaSync receives dbPath (not called empty)
      const chromaSyncCalls = source.match(/getChromaSync\([^)]*\)/g);
      expect(chromaSyncCalls).not.toBeNull();
      expect(chromaSyncCalls!.length).toBeGreaterThan(0);

      // All calls must pass dbPath, none should be empty
      for (const call of chromaSyncCalls!) {
        expect(call).not.toBe('getChromaSync()');
        expect(call).toMatch(/getChromaSync\(dbPath\)/);
      }
    });
  });

  describe('B2: MemoryRoutes observation sync', () => {
    it('passes requestDbPath to getChromaSync in handleSaveMemory', () => {
      const source = readFileSync(
        join(__dirname, '../../../../src/services/worker/http/routes/MemoryRoutes.ts'),
        'utf-8'
      );

      // Find all getChromaSync calls
      const calls = source.match(/getChromaSync\([^)]*\)/g);
      expect(calls).not.toBeNull();
      expect(calls!.length).toBeGreaterThan(0);

      // None should be empty-argument calls
      for (const call of calls!) {
        expect(call).not.toBe('getChromaSync()');
      }
    });
  });
});
