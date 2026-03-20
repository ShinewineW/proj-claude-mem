/**
 * Schema Auto-Repair Tests
 *
 * Tests the malformed schema detection and Python-based repair mechanism.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { repairMalformedSchema, hasPython3 } from '../../src/services/sqlite/Database.js';
import { logger } from '../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('Schema Auto-Repair', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `schema-repair-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  describe('hasPython3', () => {
    it('should return a string path or null', () => {
      const result = hasPython3();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('repairMalformedSchema', () => {
    it('should return false when error message does not contain object name', () => {
      const result = repairMalformedSchema('/fake/path.db', 'some other error');
      expect(result).toBe(false);
    });

    const python3 = hasPython3();
    const describeIfPython = python3 ? describe : describe.skip;

    describeIfPython('with Python3 available', () => {
      it('should repair database with orphaned index', () => {
        const dbPath = join(testDir, 'test-repair.db');

        execFileSync(python3!, ['-c', [
          'import sqlite3, sys',
          `conn = sqlite3.connect("${dbPath}")`,
          'cur = conn.cursor()',
          'cur.execute("CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)")',
          'cur.execute("CREATE INDEX idx_test_orphan ON test_data (value)")',
          'cur.execute("PRAGMA writable_schema = ON")',
          'cur.execute("DELETE FROM sqlite_master WHERE type = \'table\' AND name = \'test_data\'")',
          'cur.execute("PRAGMA writable_schema = OFF")',
          'conn.commit()',
          'conn.close()',
        ].join('\n')], { timeout: 10_000 });

        const result = repairMalformedSchema(
          dbPath,
          'malformed database schema (idx_test_orphan)'
        );
        expect(result).toBe(true);

        const repaired = new Database(dbPath, { readwrite: true });
        const integrity = repaired.prepare('PRAGMA integrity_check').get() as any;
        expect(integrity.integrity_check).toBe('ok');
        repaired.close();
      });

      it('should return false for invalid database path', () => {
        // Use a path that cannot be opened as a file (a directory)
        const result = repairMalformedSchema(
          testDir,
          'malformed database schema (idx_missing)'
        );
        expect(result).toBe(false);
      });
    });
  });
});
